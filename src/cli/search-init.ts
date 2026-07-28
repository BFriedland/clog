import chalk from "chalk";

import { runIndexCommand } from "./index-cmd.js";
import { loadConfig, saveConfig } from "../config/index.js";
import { listIndexEligibleConversationsNeedingIndex } from "../search/coherence.js";
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
import {
  assertSearchRuntimePackagesImportable,
  formatSearchRuntimeInstallCommand,
  installSearchRuntimePackages,
  SEARCH_RUNTIME_MODEL_DOWNLOAD_SIZE,
  SEARCH_RUNTIME_PACKAGE_INSTALL_SIZE,
} from "../search/runtime.js";
import { getSearchRuntimeModelCacheRoot, getSearchRuntimeRoot } from "../utils/paths.js";

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
    indexAllBranches: existingSearch?.indexAllBranches ?? false,
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

  const requiredPackages = getRequiredSearchPackages(nextSearchConfig);
  const packagesInstalled = embeddingPackagesInstalled && vectorStorePackagesInstalled;
  process.stdout.write(
    `${buildSearchSetupConsentPrompt({ packagesInstalled, packages: requiredPackages })}\n\n`,
  );
  const accepted = await confirm({
    message: "Enable local vector search with this configuration?",
    default: true,
  });

  if (!accepted) {
    process.stdout.write("Operation cancelled.\n");
    return;
  }

  await ensureRequiredSearchRuntimePackages(requiredPackages, { packagesInstalled });

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

  await saveConfig({
    ...config,
    search: nextSearchConfig,
  });
  resetSearchProviders();

  process.stdout.write(`${chalk.green("Search configured successfully.")}\n`);
  process.stdout.write(`  Embedding: ${embeddingProviders[embeddingType].name}\n`);
  process.stdout.write(`  Vector store: ${vectorStoreProviders[vectorStoreType].name}\n\n`);

  const indexingCount = await getConversationNeedingIndexCount();
  if (indexingCount === 0) {
    process.stdout.write("No saved conversations need indexing right now.\n");
    return;
  }

  const indexAccepted = await confirm({
    message: `Index ${indexingCount} saved conversation${
      indexingCount === 1 ? "" : "s"
    } that ${indexingCount === 1 ? "needs" : "need"} vector indexing now? Large conversation libraries may take a long time to process. The "clog index" command can also be run later.`,
    default: true,
  });

  if (indexAccepted) {
    process.stdout.write("\n");
    await runIndexCommand({});
    return;
  }

  process.stdout.write('\nRun "clog index" whenever you want to index saved conversations.\n');
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
}

export function buildSearchSetupConsentPrompt(options: {
  packagesInstalled: boolean;
  packages: string[];
}): string {
  const packageSize = chalk.bold(chalk.yellow(SEARCH_RUNTIME_PACKAGE_INSTALL_SIZE));
  const modelSize = chalk.bold(chalk.yellow(SEARCH_RUNTIME_MODEL_DOWNLOAD_SIZE));

  const packageLine = options.packagesInstalled
    ? `  • Packages already in ${getSearchRuntimeRoot()} (${packageSize} if reinstalled)`
    : `  • Packages (${packageSize}) installed into ${getSearchRuntimeRoot()}`;

  return [
    "This will enable local vector search:",
    packageLine,
    `  • Runtime packages: ${options.packages.join(", ")}`,
    `  • Model files (${modelSize}, downloaded once if not cached) in ${getSearchRuntimeModelCacheRoot()}`,
  ].join("\n");
}

function renderPackageStatus(packagesInstalled: boolean, packages: string[]): string {
  if (packagesInstalled) {
    return "Runtime packages: installed";
  }

  return chalk.yellow(`Runtime packages missing: ${packages.join(" ")}`);
}

async function ensureRequiredSearchRuntimePackages(
  packages: string[],
  options: { packagesInstalled: boolean },
): Promise<void> {
  if (!options.packagesInstalled) {
    writeSearchRuntimeInstallCommand("Installing vector search packages", packages);
    await installSearchRuntimePackages(packages);
    await assertSearchRuntimePackagesImportable(packages);
    return;
  }

  try {
    await assertSearchRuntimePackagesImportable(packages);
  } catch {
    writeSearchRuntimeInstallCommand("Repairing vector search packages", packages);
    await installSearchRuntimePackages(packages);
    await assertSearchRuntimePackagesImportable(packages);
  }
}

function writeSearchRuntimeInstallCommand(action: string, packages: string[]): void {
  process.stdout.write(`\n${action} in ${getSearchRuntimeRoot()}.\n`);
  process.stdout.write(`Running: ${formatSearchRuntimeInstallCommand(packages)}\n\n`);
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

function getRequiredSearchPackages(searchConfig: NonNullable<SearchConfig>): string[] {
  return Array.from(new Set([
    ...embeddingProviders[searchConfig.embedding.type].packages,
    ...vectorStoreProviders[searchConfig.vectorStore.type].packages,
  ]));
}

async function getConversationNeedingIndexCount(): Promise<number> {
  const config = await loadConfig();
  const conversations = await listIndexEligibleConversationsNeedingIndex({
    indexAllBranches: config.search?.indexAllBranches,
  });
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
