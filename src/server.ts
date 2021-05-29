#!/usr/bin/env node

import { promises as fs } from 'fs';
import http from 'http';
import ndPath from 'path';
import express, { Response } from 'express';
import minimist from 'minimist';
import sass from 'sass';
import { Server } from 'socket.io';
import * as commands from './commands';
import { RunningProcess } from './running-process';
import { ICommandParameters, IUnwatch, IWatch } from './typings';
import { Watchman } from './watchman';

const argv = minimist(process.argv.slice(2));

const app = express();

const httpServer = http.createServer(app);

const io = new Server(httpServer);

const entryPointPath = ndPath.resolve(
  __dirname,
  '../node_modules/footloose-client/dist/footloose.js'
);

const defaultStaticRoot = ndPath.resolve(
  __dirname,
  '../node_modules/footloose-config/dist'
);

const staticRoot = argv.c ? ndPath.resolve(argv.c) : defaultStaticRoot;

async function handleScss(path: string, res: Response) {
  const buf = await fs.readFile(path);
  const result = sass.renderSync({
    data: buf.toString(),
    outputStyle: 'compressed',
  });
  res.type('css').send(result.css.toString());
}

app.get(/^\/@\//, async (req, res) => {
  try {
    const path = req.url.replace('/@', '');
    res.sendFile(decodeURIComponent(path));
  } catch (e) {
    res.sendStatus(e.code === 'ENOENT' ? 404 : 500);
  }
});

app.get('/footloose.js', async (req, res) => {
  res.sendFile(entryPointPath);
});

app.get(/\.scss$/, async (req, res) => {
  const pathname = req.url.replace(/\?.*$/, '');
  await handleScss(`${staticRoot}${pathname}`, res);
});

app.use(express.static(staticRoot));

io.on('connection', (socket) => {
  socket.on('disconnect', () => {
    Watchman.close(socket);
    RunningProcess.disconnect(socket);
  });

  socket.on(
    'command',
    async (command: string, processId: string, parameters?: unknown) => {
      switch (command) {
        case 'watch': {
          const params = parameters as ICommandParameters<IWatch>;
          const result = await Watchman.register(socket, params.directoryPath);
          socket.emit('command', processId, result);
          break;
        }
        case 'unwatch': {
          const params = parameters as ICommandParameters<IUnwatch>;
          const result = Watchman.unregister(socket, params.directoryPath);
          socket.emit('command', processId, result);
          break;
        }
        case 'abort': {
          RunningProcess.abort(processId);
          break;
        }
        default: {
          if (command in commands) {
            RunningProcess.register(socket, command, processId, parameters);
          }
        }
      }
    }
  );
});

httpServer.listen(argv.p, () =>
  console.log(`Footloose listening at http://localhost:${argv.p}`)
);
