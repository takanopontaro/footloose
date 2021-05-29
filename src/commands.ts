import childProcess from 'child_process';
import fsSync, { constants, promises as fs } from 'fs';
import os from 'os';
import ndPath from 'path';
import util from 'util';
import zlib from 'zlib';
import AdmZip from 'adm-zip';
import { fromFile } from 'file-type';
import globby from 'globby';
import gunzip from 'gunzip-maybe';
import moveFile from 'move-file';
import openPath from 'open';
import tarFs from 'tar-fs';
import trash from 'trash';
import { ICommandReturn, IOpenPathApp } from './typings';

const execChildProcess = util.promisify(childProcess.exec);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeStrings(object: any): void {
  for (const key in object) {
    if (typeof object[key] === 'string') {
      object[key] = object[key].normalize('NFC');
    }
  }
}

function createReturn<T extends Record<string, unknown>>(
  base: T | null,
  statusOrError?: ICommandReturn['status'] | Error
): T & ICommandReturn {
  base = base ?? ({} as T);
  normalizeStrings(base);
  if (statusOrError instanceof Error) {
    return { ...base, status: 'error', error: statusOrError.message };
  }
  return { ...base, status: statusOrError || 'finish' };
}

async function getFsAccessAsError(
  path: string
): Promise<NodeJS.ErrnoException> {
  try {
    await fs.access(path);
    const error = new Error(`Error: EEXIST, file already exists "${path}"`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (error as any).code = 'EEXIST';
    return error;
  } catch (e) {
    return e;
  }
}

function subdirectoryExists(directory: string, directories: string[]) {
  return directories.some(
    (dir) => dir !== directory && dir.startsWith(`${directory}${ndPath.sep}`)
  );
}

function omitDuplicateDirectories(directories: string[]) {
  return directories
    .sort()
    .filter((directory) => !subdirectoryExists(directory, directories));
}

async function extractDirectories(sourcePaths: string[]) {
  const queue = sourcePaths.map(async (path) => {
    const stat = await fs.stat(path);
    return stat.isDirectory() ? path : '';
  });
  const res = await Promise.all(queue);
  return res.filter((path) => Boolean(path));
}

function deleteEmptyDirectories(path: string) {
  try {
    const stat = fsSync.statSync(path);
    if (!stat.isDirectory()) {
      return;
    }
  } catch (e) {
    return;
  }
  let files = fsSync.readdirSync(path);
  if (files.length > 0) {
    files.forEach((file) => {
      const absolutePath = ndPath.join(path, file);
      deleteEmptyDirectories(absolutePath);
    });
    files = fsSync.readdirSync(path);
  }
  if (files.length === 0) {
    fsSync.rmdirSync(path);
  }
}

type IProcessParameters = {
  copyMode: boolean;
  cwd: string;
  sourcePaths: string[];
  destinationDirectoryPath: string;
  overwrite: boolean;
};

type IProcessReturn = {
  done: number;
  failed: number;
};

async function process(
  parameters: IProcessParameters
): Promise<IProcessReturn> {
  const { copyMode, cwd, destinationDirectoryPath, overwrite, sourcePaths } =
    parameters;
  let done = 0;
  let failed = 0;
  for (const phase of ['directory', 'file']) {
    const isDirectory = phase === 'directory';
    let entries = await globby(sourcePaths, {
      dot: true,
      absolute: true,
      onlyDirectories: isDirectory,
      onlyFiles: !isDirectory,
    });
    if (isDirectory) {
      const directories = await extractDirectories(sourcePaths);
      entries = omitDuplicateDirectories([...entries, ...directories]);
    }
    const copyFlags = overwrite ? undefined : constants.COPYFILE_EXCL;
    const queue = entries.map((entry) => {
      const path = entry.replace(cwd, destinationDirectoryPath);
      const promise = isDirectory
        ? fs.mkdir(path, { recursive: true })
        : copyMode
        ? fs.copyFile(entry, path, copyFlags)
        : moveFile(entry, path, { overwrite });
      if (!overwrite) {
        return promise.then(() => done++);
      }
      return promise.then(() => done++).catch(() => failed++);
    });
    await Promise.all(queue);
  }
  return { done, failed };
}

type ICpParameters = {
  cwd: string;
  sourcePaths: string[];
  destinationDirectoryPath: string;
  overwrite: boolean;
};

type ICpReturn = ICommandReturn & Partial<IProcessReturn>;

export async function cp(parameters: ICpParameters): Promise<ICpReturn> {
  const { cwd, destinationDirectoryPath } = parameters;
  if (cwd === destinationDirectoryPath) {
    return createReturn(
      null,
      new Error('Source and destination directory are the same.')
    );
  }
  try {
    const result = await process({ copyMode: true, ...parameters });
    return createReturn(result);
  } catch (e) {
    return createReturn(null, e);
  }
}

type IMvParameters = {
  cwd: string;
  sourcePaths: string[];
  destinationDirectoryPath: string;
  overwrite: boolean;
};

type IMvReturn = ICommandReturn & Partial<IProcessReturn>;

export async function mv(parameters: IMvParameters): Promise<IMvReturn> {
  const { cwd, destinationDirectoryPath, sourcePaths } = parameters;
  if (cwd === destinationDirectoryPath) {
    return createReturn(
      null,
      new Error('Source and destination directory are the same.')
    );
  }
  const queue = sourcePaths.map(async (sourcePath) => {
    const destinationPath = ndPath.join(
      destinationDirectoryPath,
      ndPath.basename(sourcePath)
    );
    const error = await getFsAccessAsError(destinationPath);
    if (error.code !== 'ENOENT') {
      return sourcePath;
    }
    try {
      await fs.rename(sourcePath, destinationPath);
      return '';
    } catch (e) {
      return sourcePath;
    }
  });
  const res = await Promise.all(queue);
  const srcPaths = res.filter((path) => Boolean(path));
  if (srcPaths.length === 0) {
    return createReturn(null);
  }
  try {
    const result = await process({
      copyMode: false,
      ...parameters,
      sourcePaths: srcPaths,
    });
    if (result.failed === 0) {
      srcPaths.forEach((srcPath) => deleteEmptyDirectories(srcPath));
    }
    return createReturn(result);
  } catch (e) {
    return createReturn(null, e);
  }
}

type IZipParameters = {
  cwd: string;
  sourcePaths: string[];
  destinationDirectoryPath: string;
  fileName: string;
};

type IZipReturn = ICommandReturn & {
  path: string;
};

export async function zip(parameters: IZipParameters): Promise<IZipReturn> {
  const { cwd, destinationDirectoryPath, fileName, sourcePaths } = parameters;
  const destinationPath = ndPath.join(destinationDirectoryPath, fileName);
  const result = { path: destinationPath };
  const error = await getFsAccessAsError(destinationPath);
  if (error.code === 'EEXIST') {
    return createReturn(result, error);
  }
  try {
    const zip = new AdmZip();
    const queue = sourcePaths.map(async (sourcePath) => {
      const zipPath = ndPath.relative(cwd, sourcePath);
      const stat = await fs.stat(sourcePath);
      if (!stat.isDirectory()) {
        zip.addLocalFile(sourcePath);
        return;
      }
      const files = await fs.readdir(sourcePath);
      if (files.length > 0) {
        zip.addLocalFolder(sourcePath, zipPath);
      } else {
        zip.addFile(`${zipPath}/`, Buffer.from([0x00]));
      }
    });
    await Promise.all(queue);
    zip.writeZip(destinationPath);
    return createReturn(result);
  } catch (e) {
    return createReturn(result, e);
  }
}

type ITarParameters = {
  cwd: string;
  sourcePaths: string[];
  destinationDirectoryPath: string;
  fileName: string;
  gz: boolean;
};

type ITarReturn = ICommandReturn & {
  path: string;
};

export async function tar(parameters: ITarParameters): Promise<ITarReturn> {
  const { cwd, destinationDirectoryPath, fileName, gz, sourcePaths } =
    parameters;
  const destinationPath = ndPath.join(destinationDirectoryPath, fileName);
  const result = { path: destinationPath };
  const error = await getFsAccessAsError(destinationPath);
  if (error.code === 'EEXIST') {
    return createReturn(result, error);
  }
  try {
    const writeStream = fsSync.createWriteStream(destinationPath);
    const entries = sourcePaths.map((sourcePath) =>
      ndPath.relative(cwd, sourcePath)
    );
    const pack = tarFs.pack(cwd, { entries });
    if (gz) {
      const gzip = zlib.createGzip();
      pack.pipe(gzip).pipe(writeStream);
    } else {
      pack.pipe(writeStream);
    }
    return createReturn(result);
  } catch (e) {
    return createReturn(result, e);
  }
}

type IUnzipParameters = {
  sourcePath: string;
  destinationDirectoryPath: string;
  directoryName?: string;
};

type IUnzipReturn = ICommandReturn;

export async function unzip(
  parameters: IUnzipParameters
): Promise<IUnzipReturn> {
  const {
    destinationDirectoryPath,
    directoryName = '',
    sourcePath,
  } = parameters;
  const destDirPath = ndPath.join(destinationDirectoryPath, directoryName);
  const error = await getFsAccessAsError(destDirPath);
  if (directoryName && error.code === 'EEXIST') {
    return createReturn(null, error);
  }
  try {
    await fs.mkdir(destDirPath, { recursive: true });
    const zip = new AdmZip(sourcePath);
    zip.extractAllTo(destDirPath, true);
    return createReturn(null);
  } catch (e) {
    return createReturn(null, e);
  }
}

type IUntarParameters = {
  sourcePath: string;
  destinationDirectoryPath: string;
  directoryName?: string;
};

type IUntarReturn = ICommandReturn;

export async function untar(
  parameters: IUntarParameters
): Promise<IUntarReturn> {
  const {
    destinationDirectoryPath,
    directoryName = '',
    sourcePath,
  } = parameters;
  const destDirPath = ndPath.join(destinationDirectoryPath, directoryName);
  const error = await getFsAccessAsError(destDirPath);
  if (directoryName && error.code === 'EEXIST') {
    return createReturn(null, error);
  }
  try {
    const readStream = fsSync.createReadStream(sourcePath);
    const extract = tarFs.extract(destDirPath);
    readStream.pipe(gunzip()).pipe(extract);
    return createReturn(null);
  } catch (e) {
    return createReturn(null, e);
  }
}

type IRmParameters = {
  sourcePaths: string[];
};

type IRmReturn = ICommandReturn;

export async function rm(parameters: IRmParameters): Promise<IRmReturn> {
  const { sourcePaths } = parameters;
  const queue = sourcePaths.map((sourcePath) =>
    // fs.rm(sourcePath, { recursive: true })
    trash(sourcePath)
  );
  try {
    await Promise.all(queue);
    return createReturn(null);
  } catch (e) {
    return createReturn(null, e);
  }
}

type IMkdirParameters = {
  destinationDirectoryPath: string;
  directoryName: string;
};

type IMkdirReturn = ICommandReturn & {
  path: string;
};

export async function mkdir(
  parameters: IMkdirParameters
): Promise<IMkdirReturn> {
  const { destinationDirectoryPath, directoryName } = parameters;
  const destinationPath = ndPath.join(destinationDirectoryPath, directoryName);
  const result = { path: destinationPath };
  try {
    await fs.mkdir(destinationPath);
    return createReturn(result);
  } catch (e) {
    return createReturn(result, e);
  }
}

type ITouchParameters = {
  destinationDirectoryPath: string;
  fileName: string;
};

type ITouchReturn = ICommandReturn & {
  path: string;
};

export async function touch(
  parameters: ITouchParameters
): Promise<ITouchReturn> {
  const { destinationDirectoryPath, fileName } = parameters;
  const destinationPath = ndPath.join(destinationDirectoryPath, fileName);
  const result = { path: destinationPath };
  try {
    await fs.writeFile(destinationPath, '', { flag: 'wx' });
    return createReturn(result);
  } catch (e) {
    return createReturn(result, e);
  }
}

type IRenameParameters = {
  sourcePath: string;
  basename: string;
};

type IRenameReturn = ICommandReturn & {
  oldPath: string;
  newPath: string;
};

export async function rename(
  parameters: IRenameParameters
): Promise<IRenameReturn> {
  const { basename, sourcePath } = parameters;
  const destinationPath = ndPath.join(ndPath.dirname(sourcePath), basename);
  const result = { oldPath: sourcePath, newPath: destinationPath };
  const error = await getFsAccessAsError(destinationPath);
  if (error.code !== 'ENOENT') {
    return createReturn(result, error);
  }
  try {
    await fs.rename(sourcePath, destinationPath);
    return createReturn(result);
  } catch (e) {
    return createReturn(result, e);
  }
}

type IOpenParameters = {
  sourcePath: string;
  app?: IOpenPathApp;
};

type IOpenReturn = ICommandReturn;

export async function open(parameters: IOpenParameters): Promise<IOpenReturn> {
  const { app, sourcePath } = parameters;
  try {
    await openPath(sourcePath, { app });
    return createReturn(null);
  } catch (e) {
    return createReturn(null, e);
  }
}

type IVdParameters = {
  sourcePath: string;
};

type IVdReturn = ICommandReturn & {
  actualPath: string;
  virtualPath: string;
};

export async function vd(parameters: IVdParameters): Promise<IVdReturn> {
  const { sourcePath } = parameters;
  try {
    const prefix = ndPath.join(os.tmpdir(), 'footloose-');
    const destinationDirectoryPath = await fs.mkdtemp(prefix);
    const params = { destinationDirectoryPath, sourcePath };
    const result = /\.(tar(\.gz)?|tgz)$/.test(sourcePath)
      ? await untar(params)
      : await unzip(params);
    if (result.status === 'error') {
      throw new Error(result.error);
    }
    const actualPath = fsSync.realpathSync.native(destinationDirectoryPath);
    const virtualPath = fsSync.realpathSync.native(sourcePath);
    return createReturn({ actualPath, virtualPath });
  } catch (e) {
    return createReturn({ actualPath: '', virtualPath: '' }, e);
  }
}

type IRealpathParameters = {
  cwd?: string;
  sourcePath: string;
};

type IRealpathReturn = ICommandReturn & {
  path: string;
};

export async function realpath(
  parameters: IRealpathParameters
): Promise<IRealpathReturn> {
  const { cwd = '.', sourcePath } = parameters;
  try {
    const path = ndPath.resolve(cwd, sourcePath);
    return createReturn({ path: fsSync.realpathSync.native(path) });
  } catch (e) {
    return createReturn({ path: '' }, e);
  }
}

type IMimetypeParameters = {
  sourcePath: string;
};

type IMimetypeReturn = ICommandReturn & {
  mime?: string;
};

export async function mimetype(
  parameters: IMimetypeParameters
): Promise<IMimetypeReturn> {
  const { sourcePath } = parameters;
  try {
    const mime = await fromFile(sourcePath);
    return createReturn({ mime: mime?.mime });
  } catch (e) {
    return createReturn(null, e);
  }
}

type IExecParameters = {
  command: string;
};

type IExecReturn = ICommandReturn & {
  stdout?: string;
};

export async function exec(parameters: IExecParameters): Promise<IExecReturn> {
  const { command } = parameters;
  try {
    const { stderr, stdout } = await execChildProcess(command);
    if (stderr) {
      return createReturn(null, new Error(stderr));
    }
    return createReturn({ stdout });
  } catch (e) {
    return createReturn(null, e);
  }
}
