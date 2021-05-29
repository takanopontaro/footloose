import type {
  cp,
  exec,
  mimetype,
  mkdir,
  mv,
  open,
  realpath,
  rename,
  rm,
  tar,
  touch,
  untar,
  unzip,
  vd,
  zip,
} from './commands';

export type IEntryType = 'directory' | 'file' | 'link' | 'unknown';

export type IEntry = {
  type: IEntryType;
  mime: string;
  path: string;
  dir: string;
  name: string;
  ext: string;
  size: number;
  atime: number;
  mtime: number;
  ctime: number;
  birthtime: number;
  parent: boolean;
};

export type ICommandReturn = {
  status: 'finish' | 'error' | 'abort';
  error?: string;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ICommandInterface<C, F extends (...args: any) => any> = (
  command: C,
  processId: string,
  parameters: Parameters<F>[0]
) => ReturnType<F> extends PromiseLike<infer U> ? U : ReturnType<F>;

type IWatchFn = (parameters: {
  directoryPath: string;
}) => ICommandReturn & { directoryPath?: string };

export type IWatch = ICommandInterface<'watch', IWatchFn>;

type IUnwatchFn = (parameters: { directoryPath: string }) => ICommandReturn;

export type IUnwatch = ICommandInterface<'unwatch', IUnwatchFn>;

type IAbortFn = () => ICommandReturn;

export type IAbortCommand = ICommandInterface<'abort', IAbortFn>;

export type ICopy = ICommandInterface<'cp', typeof cp>;

export type IMove = ICommandInterface<'mv', typeof mv>;

export type IZip = ICommandInterface<'zip', typeof zip>;

export type ITar = ICommandInterface<'tar', typeof tar>;

export type IUnzip = ICommandInterface<'unzip', typeof unzip>;

export type IUntar = ICommandInterface<'untar', typeof untar>;

export type IRemove = ICommandInterface<'rm', typeof rm>;

export type IMakeDirectory = ICommandInterface<'mkdir', typeof mkdir>;

export type ITouch = ICommandInterface<'touch', typeof touch>;

export type IRename = ICommandInterface<'rename', typeof rename>;

export type IOpenPath = ICommandInterface<'open', typeof open>;

export type IMakeVirtualDirectory = ICommandInterface<'vd', typeof vd>;

export type IRealPath = ICommandInterface<'realpath', typeof realpath>;

export type IMimeType = ICommandInterface<'mimetype', typeof mimetype>;

export type IExec = ICommandInterface<'exec', typeof exec>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ICommandParameters<T extends (...args: any) => any> =
  Parameters<T>[2];

export type IOpenPathApp = {
  name: string | string[];
  arguments?: string[];
};
