import { Stats, promises as fs } from 'fs';
import ndPath from 'path';
import chokidar from 'chokidar';
import { fromFile } from 'file-type';
import minimist from 'minimist';
import { Socket } from 'socket.io';
import { debounce } from 'throttle-debounce';
import { IEntry, IEntryType, IUnwatch, IWatch } from './typings';
import { WatchInfo } from './watch-info';

const argv = minimist(process.argv.slice(2));

class WatchmanClass {
  watchInfoMap = new Map<string, WatchInfo>();

  constructor() {
    this.monitorDirectory = debounce(100, this.monitorDirectory.bind(this));
  }

  validatePath(directoryPath: string): true | Error {
    if (!ndPath.isAbsolute(directoryPath)) {
      return new Error(`${directoryPath} is not an absolute path.`);
    }
    return true;
  }

  resolvePath(path: string): string {
    return ndPath.resolve(path).replace(/^[a-z](?=:)/, (c) => c.toUpperCase());
  }

  monitorDirectory(event: string, path: string): void {
    if (event === 'root-changed' || event === 'moved') {
      this.handleError(path, new Error(`${path} not available.`));
    }
  }

  async register(
    socket: Socket,
    directoryPath: string
  ): Promise<ReturnType<IWatch>> {
    const validationResult = this.validatePath(directoryPath);
    if (validationResult !== true) {
      return { status: 'error', error: validationResult.message };
    }
    directoryPath = this.resolvePath(directoryPath);
    const watchInfo = this.watchInfoMap.get(directoryPath);
    if (watchInfo) {
      watchInfo.addSocket(socket);
      watchInfo.sendLastEntries(socket);
      return { status: 'finish', directoryPath };
    }
    const error = await fs.access(directoryPath).catch((e) => e);
    if (error) {
      return { status: 'error', error: error.message };
    }
    const listener = debounce(100, () => this.readDirectory(directoryPath));
    const watcher = chokidar
      .watch(directoryPath, { depth: 0 })
      .on('all', listener)
      .on('raw', this.monitorDirectory);
    const info = new WatchInfo(watcher, socket, directoryPath);
    this.watchInfoMap.set(directoryPath, info);
    return { status: 'finish', directoryPath };
  }

  unregister(socket: Socket, directoryPath: string): ReturnType<IUnwatch> {
    const validationResult = this.validatePath(directoryPath);
    if (validationResult !== true) {
      return { status: 'error', error: validationResult.message };
    }
    directoryPath = this.resolvePath(directoryPath);
    const watchInfo = this.watchInfoMap.get(directoryPath);
    watchInfo?.deleteSocket(socket);
    if (watchInfo?.isEmpty) {
      watchInfo.destroy();
      this.watchInfoMap.delete(directoryPath);
    }
    return { status: 'finish' };
  }

  getEntryType(stats: Stats): IEntryType {
    switch (true) {
      case stats.isFile(): {
        return 'file';
      }
      case stats.isDirectory(): {
        return 'directory';
      }
      case stats.isSymbolicLink(): {
        return 'link';
      }
      default: {
        return 'unknown';
      }
    }
  }

  async getEntry(path: string, parent = false): Promise<IEntry> {
    const info = ndPath.parse(path);
    const common = {
      path,
      mime: '',
      dir: info.dir,
      name: info.name,
      ext: info.ext,
      parent,
    };
    try {
      const stats = await fs.stat(path);
      const type = this.getEntryType(stats);
      if (type === 'directory') {
        common.name += common.ext;
        common.ext = '';
      } else if (argv.m) {
        const mime = await fromFile(path);
        common.mime = mime?.mime ?? '';
      }
      return {
        ...common,
        type,
        size: stats.size,
        atime: +stats.atime,
        mtime: +stats.mtime,
        ctime: +stats.ctime,
        birthtime: +stats.birthtime,
      };
    } catch (e) {
      return {
        ...common,
        type: 'unknown',
        size: 0,
        atime: 0,
        mtime: 0,
        ctime: 0,
        birthtime: 0,
      };
    }
  }

  handleError(directoryPath: string, error: Error): void {
    const watchInfo = this.watchInfoMap.get(directoryPath);
    if (watchInfo) {
      watchInfo.broadcastError(error);
      watchInfo.destroy();
      this.watchInfoMap.delete(directoryPath);
    }
  }

  async readDirectory(directoryPath: string): Promise<void> {
    const watchInfo = this.watchInfoMap.get(directoryPath);
    if (!watchInfo) {
      return;
    }
    try {
      const names = await fs.readdir(directoryPath);
      const queue = names.map((name) => {
        const path = ndPath.join(directoryPath, name);
        return this.getEntry(path.normalize('NFC'));
      });
      const parentPath = ndPath.resolve(directoryPath, '..');
      if (parentPath !== directoryPath) {
        const promise = this.getEntry(parentPath.normalize('NFC'), true);
        queue.unshift(promise);
      }
      const entries = await Promise.all(queue);
      watchInfo.broadcastEntries(entries);
    } catch (e) {
      this.handleError(directoryPath, e);
    }
  }

  close(socket: Socket): void {
    this.watchInfoMap.forEach((info) => {
      if (info.hasSocket(socket)) {
        this.unregister(socket, info.path);
      }
    });
  }
}

const Watchman = new WatchmanClass();

export { Watchman };
