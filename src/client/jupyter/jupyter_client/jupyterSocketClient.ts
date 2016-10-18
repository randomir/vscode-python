"use strict";

import { SocketCallbackHandler } from "../../common/comms/socketCallbackHandler";
import { Commands, ResponseCommands } from "./commands";
import { SocketServer } from '../../common/comms/socketServer';
import { IdDispenser } from '../../common/idDispenser';
import { createDeferred, Deferred } from '../../common/helpers';
import { KernelCommand } from './contracts';
import { JupyterMessage, ParsedIOMessage } from '../contracts';
import { Helpers } from '../common/helpers';
import * as Rx from 'rx';

export class JupyterSocketClient extends SocketCallbackHandler {
    constructor(socketServer: SocketServer) {
        super(socketServer);
        this.registerCommandHandler(ResponseCommands.Pong, this.onPong.bind(this));
        this.registerCommandHandler(ResponseCommands.ListKernelsSpecs, this.onKernelsListed.bind(this));
        this.registerCommandHandler(ResponseCommands.Error, this.onError.bind(this));
        this.registerCommandHandler(ResponseCommands.KernelStarted, this.onKernelStarted.bind(this));
        this.registerCommandHandler(ResponseCommands.KernelInterrupted, this.onKernelCommandComplete.bind(this));
        this.registerCommandHandler(ResponseCommands.KernelRestarted, this.onKernelCommandComplete.bind(this));
        this.registerCommandHandler(ResponseCommands.KernelShutdown, this.onKernelCommandComplete.bind(this));
        this.registerCommandHandler(ResponseCommands.RunCode, this.onCodeSentForExecution.bind(this));
        this.registerCommandHandler(ResponseCommands.ShellResult, this.onShellResult.bind(this));
        this.registerCommandHandler(ResponseCommands.IOPUBMessage, this.onIOPUBMessage.bind(this));
        this.idDispenser = new IdDispenser();
    }

    private idDispenser: IdDispenser;
    private pid: number;
    private guid: string;

    protected handleHandshake(): boolean {
        if (typeof this.guid !== 'string') {
            this.guid = this.stream.readStringInTransaction();
            if (typeof this.guid !== 'string') {
                return false;
            }
        }

        if (typeof this.pid !== 'number') {
            this.pid = this.stream.readInt32InTransaction();
            if (typeof this.pid !== 'number') {
                return false;
            }
        }

        this.emit('handshake');
        return true;
    }

    private pendingCommands = new Map<string, Deferred<any>>();

    private createId<T>(): [Deferred<T>, string] {
        const def = createDeferred<T>();
        const id = this.idDispenser.Allocate().toString();
        this.pendingCommands.set(id, def);
        return [def, id];
    }
    private releaseId(id: string) {
        this.pendingCommands.delete(id);
        this.idDispenser.Free(parseInt(id));
    }

    public listKernelSpecs(): Promise<any> {
        const [def, id] = this.createId<any>();
        this.SendRawCommand(Commands.ListKernelSpecsBytes);
        this.stream.WriteString(id);
        return def.promise;
    }

    private onKernelsListed() {
        const id = this.stream.readStringInTransaction();
        const kernels = this.stream.readStringInTransaction();
        if (typeof kernels !== 'string') {
            return;
        }

        const def = this.pendingCommands.get(id);
        this.releaseId(id);

        let kernelList: any;
        try {
            kernelList = JSON.parse(kernels);
        }
        catch (ex) {
            def.reject(ex);
            return;
        }

        def.resolve(kernelList);
    }

    public startKernel(kernelName: string): Promise<[string, any, string]> {
        const [def, id] = this.createId<any>();
        this.SendRawCommand(Commands.StartKernelBytes);
        this.stream.WriteString(id);
        this.stream.WriteString(kernelName);
        return def.promise;
    }
    public onKernelStarted() {
        const id = this.stream.readStringInTransaction();
        const kernelUUID = this.stream.readStringInTransaction();
        const configStr = this.stream.readStringInTransaction();
        const connectionFile = this.stream.readStringInTransaction();
        if (typeof connectionFile !== 'string') {
            return;
        }
        const def = this.pendingCommands.get(id);
        let config = {};
        try {
            config = JSON.parse(configStr);
        }
        catch (ex) {
            def.reject(ex);
            return;
        }
        this.releaseId(id);
        def.resolve([kernelUUID, config, connectionFile]);
    }
    public sendKernelCommand(kernelUUID: string, command: KernelCommand): Promise<any> {
        const [def, id] = this.createId<any>();
        let commandBytes: Buffer;
        switch (command) {
            case KernelCommand.interrupt: {
                commandBytes = Commands.InterruptKernelBytes;
                break;
            }
            case KernelCommand.restart: {
                commandBytes = Commands.RestartKernelBytes;
                break;
            }
            case KernelCommand.shutdown: {
                commandBytes = Commands.ShutdownKernelBytes;
                break;
            }
            default: {
                throw new Error('Unrecognized Kernel Command');
            }
        }
        this.SendRawCommand(commandBytes);
        this.stream.WriteString(id);
        this.stream.WriteString(kernelUUID);
        return def.promise;
    }
    public onKernelCommandComplete() {
        const id = this.stream.readStringInTransaction();
        if (typeof id !== 'string') {
            return;
        }
        const def = this.pendingCommands.get(id);
        this.releaseId(id);
        def.resolve();
    }
    public ping(message: string) {
        const [def, id] = this.createId<string[]>();
        this.SendRawCommand(Commands.PingBytes);
        this.stream.WriteString(id);
        this.stream.WriteString(message);
        return def.promise;
    }

    private onPong() {
        const id = this.stream.readStringInTransaction();
        const message = this.stream.readStringInTransaction();
        if (typeof message !== 'string') {
            return;
        }
        const def = this.pendingCommands.get(id);
        this.releaseId(id);
        def.resolve(message);
    }

    private msgSubject = new Map<string, Rx.Subject<ParsedIOMessage>>();
    private unhandledMessages = new Map<string, ParsedIOMessage[]>();
    private finalMessage = new Map<string, { shellMessage?: ParsedIOMessage, ioStatusSent: boolean }>();
    runCode(code: string): Rx.IObservable<ParsedIOMessage> {
        const [def, id] = this.createId<string>();
        this.SendRawCommand(Commands.RunCodeBytes);
        this.stream.WriteString(id);
        this.stream.WriteString(code);

        const observable = new Rx.Subject<ParsedIOMessage>();
        def.promise.then(msg_id => {
            this.msgSubject.set(msg_id, observable);

            // Remember we could have received both messages together
            // I.e. we could have received the msg_id (response) for code execution as well as the shell and io message
            if (this.unhandledMessages.has(msg_id)) {
                const messages = this.unhandledMessages.get(msg_id);
                messages.forEach(msg => observable.onNext(msg));
            }
        }).catch(reason => {
            observable.onError(reason);
        });

        return observable;
    }
    private onCodeSentForExecution() {
        const id = this.stream.readStringInTransaction();
        const msg_id = this.stream.readStringInTransaction();
        if (typeof msg_id !== 'string') {
            return;
        }
        const def = this.pendingCommands.get(id);
        this.releaseId(id);
        def.resolve(msg_id);
    }

    private onShellResult() {
        const jsonResult = this.stream.readStringInTransaction();
        if (typeof jsonResult !== 'string') {
            return;
        }
        try {
            const message = JSON.parse(jsonResult) as JupyterMessage;
            if (!Helpers.isValidMessag(message)) {
                return;
            }
            const msg_type = message.header.msg_type;
            if (msg_type === 'status') {
                this.emit('status', message.content.execution_state);
            }
            const msg_id = message.parent_header.msg_id;
            if (!msg_id) {
                return;
            }
            if (!this.msgSubject.has(msg_id)) {
                return;
            }
            const subject = this.msgSubject.get(msg_id);
            const status = message.content.status;
            let parsedMesage: ParsedIOMessage;
            switch (status) {
                case 'error': {
                    // http://jupyter-client.readthedocs.io/en/latest/messaging.html#request-reply
                    if (msg_type !== 'complete_reply' && msg_type !== 'inspect_reply') {
                        parsedMesage = {
                            data: 'error',
                            type: 'text',
                            stream: 'status'
                        };
                    }
                    break;
                }
                case 'ok': {
                    // http://jupyter-client.readthedocs.io/en/latest/messaging.html#request-reply
                    if (msg_type !== 'complete_reply' && msg_type !== 'inspect_reply') {
                        parsedMesage = {
                            data: 'ok',
                            type: 'text',
                            stream: 'status'
                        };
                    }
                }
            }
            if (!parsedMesage) {
                return;
            }
            if (this.finalMessage.has(msg_id)) {
                const info = this.finalMessage.get(msg_id);
                // If th io message with status='idle' has been received, that means message execution is deemed complete
                if (info.ioStatusSent) {
                    this.finalMessage.delete(msg_id);
                    subject.onNext(parsedMesage);
                    subject.onCompleted();
                }
            }
            else {
                // Wait for the io message with status='idle' to arrive
                this.finalMessage.set(msg_id, { shellMessage: parsedMesage, ioStatusSent: false });
            }
        }
        catch (ex) {
            this.emit('shellmessagepareerror', ex, jsonResult);
        }
    }

    private onIOPUBMessage() {
        const jsonResult = this.stream.readStringInTransaction();
        if (typeof jsonResult !== 'string') {
            return;
        }
        try {
            const message = JSON.parse(jsonResult) as JupyterMessage;
            if (!Helpers.isValidMessag(message)) {
                return;
            }
            const msg_type = message.header.msg_type;
            if (msg_type === 'status') {
                this.emit('status', message.content.execution_state);
            }
            const msg_id = message.parent_header.msg_id;
            if (!msg_id) {
                return;
            }

            // Ok, if we have received a status of 'idle' this means the execution has completed
            if (msg_type === 'status' && message.content.execution_state === 'idle' && this.msgSubject.has(msg_id)) {
                // Wait for the shell message to come through
                setTimeout(() => {
                    const subject = this.msgSubject.get(msg_id);
                    this.msgSubject.delete(msg_id);
                    // Last message sent on shell channel (status='ok' or status='error')
                    // and now we have a status message, this means the exection is deemed complete
                    if (this.finalMessage.has(msg_id)) {
                        const info = this.finalMessage.get(msg_id);
                        this.finalMessage.delete(msg_id);
                        if (info.shellMessage) {
                            subject.onNext(info.shellMessage);
                        }
                        subject.onCompleted();
                    }
                    else {
                        this.finalMessage.set(msg_id, { ioStatusSent: true });
                    }
                }, 10);
            }

            const parsedMesage = Helpers.parseIOMessage(message);
            if (!parsedMesage) {
                return;
            }
            if (this.msgSubject.has(msg_id)) {
                this.msgSubject.get(msg_id).onNext(parsedMesage);
            }
            else {
                let data = [];
                if (this.unhandledMessages.has(msg_id)) {
                    data = this.unhandledMessages.get(msg_id);
                }
                data.push(parsedMesage);
                this.unhandledMessages.set(msg_id, data);
                return;
            }
        }
        catch (ex) {
            this.emit('iopubmessagepareerror', ex, jsonResult);
        }
    }

    private onError() {
        const cmd = this.stream.readStringInTransaction();
        const id = this.stream.readStringInTransaction();
        const trace = this.stream.readStringInTransaction();
        if (typeof trace !== 'string') {
            return;
        }
        if (id.length > 0 && this.pendingCommands.has(id)) {
            const def = this.pendingCommands.get(id);
            this.pendingCommands.delete(id);
            def.reject(new Error(`Command: ${cmd}, Id: ${id}, Python Trace: ${trace}`));
            return;
        }
        this.emit("commanderror", { command: cmd, id: id, trace: trace });
    }
}
