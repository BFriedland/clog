import chalk from "chalk";

const none = (s: string) => s;

export const stateColors = {
  discovered: chalk.red,
  staged: chalk.green,
  published: none,
  excluded: chalk.dim,
  modified: chalk.red,
};
