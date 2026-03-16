import chalk from "chalk";
import { createInterface } from "node:readline";
import { withDb } from "../db/index.js";

function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

export async function renameAuthorCommand(
  oldName: string,
  newName: string
): Promise<void> {
  const count = await withDb((ctx) => ctx.countByAuthorLocal(oldName));

  if (count === 0) {
    throw new Error(`No local conversations found with author "${oldName}". Run \`clog list --columns all\` to see authors.`);
  }

  console.log(
    `This will rename author "${oldName}" to "${newName}" on ${count} local conversations.`
  );
  console.log(
    `On next push, conversations will appear under "${newName}/" in the shared repo.`
  );
  console.log(
    chalk.red(
      `The old "${oldName}/" directory will remain until manually removed from the repo.`
    )
  );

  const confirmed = await confirm("Continue?");
  if (!confirmed) {
    console.log("Aborted.");
    return;
  }

  const renamed = await withDb((ctx) => ctx.renameAuthor(oldName, newName));
  console.log(chalk.green(`Renamed ${renamed} conversation(s)`) + ` from "${oldName}" to "${newName}".`);
}
