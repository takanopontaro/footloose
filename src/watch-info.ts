import chokidar from 'chokidar';
import { Socket } from 'socket.io';
import { IEntry } from './typings';

class WatchInfo {
  watcher: chokidar.FSWatcher;
  sockets = new Set<Socket>();
  path: string;
  lastEntries: IEntry[] = [];

  constructor(
    watcher: chokidar.FSWatcher,
    socket: Socket,
    directoryPath: string
  ) {
    this.watcher = watcher;
    this.sockets.add(socket);
    this.path = directoryPath;
  }

  get isEmpty(): boolean {
    return this.sockets.size === 0;
  }

  addSocket(socket: Socket): void {
    this.sockets.add(socket);
  }

  deleteSocket(socket: Socket): void {
    this.sockets.delete(socket);
  }

  hasSocket(socket: Socket): boolean {
    return this.sockets.has(socket);
  }

  broadcast(event: string, ...args: unknown[]): void {
    this.sockets.forEach((socket) => WatchInfo.send(socket, event, ...args));
  }

  broadcastEntries(entries: IEntry[]): void {
    this.lastEntries = entries;
    this.broadcast('directoryUpdate', this.path, entries);
  }

  broadcastError(error: Error): void {
    this.sockets.forEach((socket) =>
      WatchInfo.sendError(socket, this.path, error)
    );
  }

  sendLastEntries(socket: Socket): void {
    WatchInfo.send(socket, 'directoryUpdate', this.path, this.lastEntries);
  }

  static send(socket: Socket, event: string, ...args: unknown[]): void {
    socket.emit(event, ...args);
  }

  static sendError(socket: Socket, directoryPath: string, error: Error): void {
    socket.emit('error', directoryPath, error.message);
  }

  destroy(): void {
    this.watcher.close();
    this.sockets.clear();
  }
}

export { WatchInfo };
