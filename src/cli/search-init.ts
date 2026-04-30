import chalk from "chalk";
import { spawn } from "node:child_process";

import { runIndexCommand } from "./index-cmd.js";
import { loadConfig, saveConfig } from "../config/index.js";
import { listConversations } from "../db/index.js";
import { resetSearchProviders } from "../search/deps.js";
import { SearchSetupIncompleteError } from "../search/errors.js";
import {
  checkPackages,
  embeddingProviders,
  type EmbeddingProviderType,
  type SearchConfig,
  type VectorStoreProviderType,
  vectorStoreProviders,
} from "../search/providers.js";

const SEARCH_INSTALL_COMMAND = ["npm", "install", "vectra", "@huggingface/transformers"] as const;

export async function runSearchInitCommand(): Promise<void> {
  const { confirm, select } = await loadInquirerPrompts();
  const config = await loadConfig();
  const existingSearch = config.search;

  const embeddingType = await chooseEmbeddingProvider(select, existingSearch);
  const embeddingPackagesInstalled = await checkPackages(embeddingProviders[embeddingType].packages);

  const vectorStoreType = await chooseVectorStoreProvider(select, existingSearch);
  const vectorStorePackagesInstalled = await checkPackages(
    vectorStoreProviders[vectorStoreType].packages,
  );

  const nextSearchConfig: SearchConfig = {
    embedding: {
      type: embeddingType,
      model: existingSearch?.embedding.type === "transformers"
        ? existingSearch.embedding.model
        : "Xenova/all-MiniLM-L6-v2",
    },
    vectorStore: {
      type: vectorStoreType,
    },
  };

  renderSetupSummary({
    existingSearch,
    embeddingType,
    embeddingPackagesInstalled,
    vectorStoreType,
    vectorStorePackagesInstalled,
    model:
      nextSearchConfig.embedding.type === "transformers"
        ? nextSearchConfig.embedding.model
        : undefined,
  });

  const accepted = await confirm({
    message: "Save this configuration and continue setup?",
    default: true,
  });

  if (!accepted) {
    process.stdout.write("Setup cancelled.\n");
    return;
  }

  await saveConfig({
    ...config,
    search: nextSearchConfig,
  });
  resetSearchProviders();

  let installCompleted = embeddingPackagesInstalled && vectorStorePackagesInstalled;
  if (!installCompleted) {
    const installAccepted = await confirm({
      message: `Install the required runtime packages now?\n\n  ${SEARCH_INSTALL_COMMAND.join(" ")}`,
      default: true,
    });

    if (!installAccepted) {
      process.stdout.write(
        '\nSearch config was saved, but setup is incomplete. Run "clog search --init" to finish setup.\n',
      );
      return;
    }

    await runVisibleInstall();
    installCompleted = true;
  }

  process.stdout.write("\nInitializing the embedding model now.\n\n");

  try {
    await warmConfiguredEmbeddingModel(nextSearchConfig);
  } catch (error) {
    if (error instanceof SearchSetupIncompleteError) {
      throw error;
    }
    throw new Error(
      `Search setup could not finish initializing the embedding model: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  process.stdout.write(`${chalk.green("Search configured successfully.")}\n`);
  process.stdout.write(`  Embedding: ${embeddingProviders[embeddingType].name}\n`);
  process.stdout.write(`  Vector store: ${vectorStoreProviders[vectorStoreType].name}\n\n`);

  if (installCompleted) {
    const savedCount = await getSavedConversationCount();
    if (savedCount === 0) {
      process.stdout.write("No saved conversations are available to index right now.\n");
      return;
    }

    const indexAccepted = await confirm({
      message: `Index all ${savedCount} saved conversation${
        savedCount === 1 ? "" : "s"
      } now?`,
      default: true,
    });

    if (indexAccepted) {
      process.stdout.write("\n");
      await runIndexCommand({});
      return;
    }

    process.stdout.write('\nRun "clog index" whenever you want to index saved conversations.\n');
  }
}

function renderSetupSummary(input: {
  existingSearch: SearchConfig;
  embeddingType: EmbeddingProviderType;
  embeddingPackagesInstalled: boolean;
  vectorStoreType: VectorStoreProviderType;
  vectorStorePackagesInstalled: boolean;
  model?: string;
}): void {
  if (input.existingSearch) {
    process.stdout.write(
      `Current config: embedding=${input.existingSearch.embedding.type}, vectorStore=${input.existingSearch.vectorStore.type}\n\n`,
    );
  }

  process.stdout.write("New search configuration\n");
  process.stdout.write(
    `  Embedding: ${embeddingProviders[input.embeddingType].name}\n`,
  );
  process.stdout.write(
    `    ${embeddingProviders[input.embeddingType].description}\n`,
  );
  if (input.model) {
    process.stdout.write(`    Model: ${input.model}\n`);
  }
  process.stdout.write(
    `    ${renderPackageStatus(input.embeddingPackagesInstalled, embeddingProviders[input.embeddingType].packages)}\n`,
  );

  process.stdout.write(
    `  Vector store: ${vectorStoreProviders[input.vectorStoreType].name}\n`,
  );
  process.stdout.write(
    `    ${vectorStoreProviders[input.vectorStoreType].description}\n`,
  );
  process.stdout.write(
    `    ${renderPackageStatus(input.vectorStorePackagesInstalled, vectorStoreProviders[input.vectorStoreType].packages)}\n\n`,
  );

  process.stdout.write(
    `If packages are missing, setup will automatically run:\n  ${SEARCH_INSTALL_COMMAND.join(" ")}\n\n`,
  );
  process.stdout.write(
    "Setup will also initialize the embedding model now. For the default local provider, transformers.js may download Xenova/all-MiniLM-L6-v2 from the Hugging Face Hub if it is not already cached locally, at a size of about 30MB.\n\n",
  );
}

function renderPackageStatus(packagesInstalled: boolean, packages: string[]): string {
  if (packagesInstalled) {
    return "Runtime packages: installed";
  }

  return chalk.yellow(`Runtime packages missing: ${packages.join(" ")}`);
}

async function runVisibleInstall(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["install", "vectra", "@huggingface/transformers"],
      {
        stdio: "inherit",
        shell: false,
      },
    );

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Package installation failed with exit code ${code ?? "unknown"}.`));
    });
  });
}

async function warmConfiguredEmbeddingModel(searchConfig: NonNullable<SearchConfig>): Promise<void> {
  switch (searchConfig.embedding.type) {
    case "transformers": {
      const { warmTransformersModel } = await import("../search/embeddings/transformers.js");
      await warmTransformersModel(searchConfig.embedding);
      return;
    }
    default:
      throw new Error(`Unknown embedding provider: ${(searchConfig.embedding as { type: string }).type}`);
  }
}

async function getSavedConversationCount(): Promise<number> {
  const conversations = await listConversations({ states: ["saved"] });
  return conversations.length;
}

async function loadInquirerPrompts(): Promise<{
  confirm: typeof import("@inquirer/prompts").confirm;
  select: typeof import("@inquirer/prompts").select;
}> {
  try {
    const prompts = await import("@inquirer/prompts");
    return {
      confirm: prompts.confirm,
      select: prompts.select,
    };
  } catch {
    throw new Error(
      'Missing dependency: @inquirer/prompts. Run "npm install @inquirer/prompts".',
    );
  }
}

async function chooseEmbeddingProvider(
  select: typeof import("@inquirer/prompts").select,
  existingSearch: SearchConfig,
): Promise<EmbeddingProviderType> {
  const providerKeys = Object.keys(embeddingProviders) as EmbeddingProviderType[];
  if (providerKeys.length === 1) {
    return providerKeys[0];
  }

  return select<EmbeddingProviderType>({
    message: "Which embedding provider?",
    choices: providerKeys.map((key) => ({
      value: key,
      name: embeddingProviders[key].name,
      description: embeddingProviders[key].description,
    })),
    default: existingSearch?.embedding.type ?? providerKeys[0],
  });
}

async function chooseVectorStoreProvider(
  select: typeof import("@inquirer/prompts").select,
  existingSearch: SearchConfig,
): Promise<VectorStoreProviderType> {
  const providerKeys = Object.keys(vectorStoreProviders) as VectorStoreProviderType[];
  if (providerKeys.length === 1) {
    return providerKeys[0];
  }

  return select<VectorStoreProviderType>({
    message: "Which vector store?",
    choices: providerKeys.map((key) => ({
      value: key,
      name: vectorStoreProviders[key].name,
      description: vectorStoreProviders[key].description,
    })),
    default: existingSearch?.vectorStore.type ?? providerKeys[0],
  });
}
