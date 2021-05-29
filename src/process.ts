import * as commands from './commands';

const [, , command, parameters] = process.argv;

if (command in commands === false) {
  process.exit(1);
}

(async () => {
  try {
    const params = JSON.parse(parameters);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (commands as any)[command](params);
    process.send?.(JSON.stringify(result));
  } catch (e) {
    process.exit(1);
  }
})();
