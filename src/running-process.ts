import { ChildProcess, fork } from 'child_process';
import ndPath from 'path';
import { Socket } from 'socket.io';
import { ICommandReturn } from './typings';

const processPath = ndPath.join(__dirname, 'process');

class RunningProcessClass {
  list = new Map<string, { process: ChildProcess; socket: Socket }>();

  register(
    socket: Socket,
    command: string,
    processId: string,
    parameters?: unknown
  ): void {
    const params = JSON.stringify(parameters);
    const process = fork(processPath, [command, params]);
    const listener = this.createListener(socket, processId);
    process.on('exit', listener);
    process.on('error', listener);
    process.on('message', (result) =>
      socket.emit('command', processId, JSON.parse(result.toString()))
    );
    this.list.set(processId, { process, socket });
  }

  createListener(
    socket: Socket,
    processId: string
  ): (code: 0 | 1 | null) => void {
    // 0=ok 1=error null=killed
    return (code) => {
      this.list.delete(processId);
      if (code === 0) {
        return;
      }
      const result: ICommandReturn =
        code === null
          ? { status: 'abort' }
          : { status: 'error', error: 'Unexpected errors occurred.' };
      socket.emit('command', processId, result);
    };
  }

  abort(processId: string): void {
    this.list.get(processId)?.process.kill();
  }

  disconnect(socket: Socket): void {
    [...this.list]
      .filter(([, object]) => socket === object.socket)
      .forEach(([processId]) => this.abort(processId));
  }
}

const RunningProcess = new RunningProcessClass();

export { RunningProcess };
