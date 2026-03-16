import chalk from "chalk";
import { loadConfig, saveConfig } from "../config/schema.js";
import {
  embeddingProviders,
  vectorStoreProviders,
  checkPackages,
  type EmbeddingProviderType,
  type VectorStoreProviderType,
  type SearchConfig,
} from "../search/providers.js";
import { resetSearchProviders } from "../search/deps.js";

export async function searchInitCommand(): Promise<void> {
  let select: typeof import("@inquirer/prompts").select;
  let confirm: typeof import("@inquirer/prompts").confirm;
  try {
    ({ select, confirm } = await import("@inquirer/prompts"));
  } catch {
    throw new Error(
      'Missing dependency: @inquirer/prompts. Run `npm install @inquirer/prompts` to install.',
    );
  }

  const config = await loadConfig();
  const existingSearch = config.search as SearchConfig | null;

  if (existingSearch) {
    console.log(
      chalk.dim(
        `Current config: embedding=${existingSearch.embedding.type}, vectorStore=${existingSearch.vectorStore.type}`,
      ),
    );
    console.log("");
  }

  // --- Embedding provider ---
  const embeddingKeys = Object.keys(embeddingProviders) as EmbeddingProviderType[];
  let embeddingType: EmbeddingProviderType;

  if (embeddingKeys.length === 1) {
    embeddingType = embeddingKeys[0];
    const entry = embeddingProviders[embeddingType];
    console.log(`Embedding provider: ${chalk.bold(entry.name)}`);
    console.log(chalk.dim(`  ${entry.description}`));
    console.log("");
  } else {
    embeddingType = await select<EmbeddingProviderType>({
      message: "Which embedding provider?",
      choices: Object.entries(embeddingProviders).map(([key, entry]) => ({
        value: key as EmbeddingProviderType,
        name: entry.name,
        description: entry.description,
      })),
      default: (existingSearch?.embedding.type ?? embeddingKeys[0]) as EmbeddingProviderType,
    });
  }

  const embeddingEntry = embeddingProviders[embeddingType];

  // Check packages
  const embeddingReady = await checkPackages(embeddingEntry.packages);
  if (!embeddingReady) {
    console.log(
      chalk.yellow(
        `Required packages not found. Install them with:\n  npm install ${embeddingEntry.packages.join(" ")}\n`,
      ),
    );
    const proceed = await select({
      message: "Continue setup anyway? (you can install packages later)",
      choices: [
        { value: true, name: "Yes, save config and install later" },
        { value: false, name: "No, cancel setup" },
      ],
    });
    if (!proceed) {
      console.log("Setup cancelled.");
      return;
    }
  }

  // Provider-specific config
  const embeddingConfig: Record<string, unknown> = { type: embeddingType };

  if (embeddingType === "transformers") {
    // Currently only one well-tested model. When more models are worth
    // offering (e.g. a higher-quality option), replace this with a select
    // prompt listing curated choices rather than a freeform text input.
    const model =
      existingSearch?.embedding.type === "transformers"
        ? existingSearch.embedding.model
        : "Xenova/all-MiniLM-L6-v2";
    embeddingConfig.model = model;
    console.log(chalk.dim(`  Model: ${model}`));
    console.log("");
  }

  // --- Vector store ---
  const vectorStoreKeys = Object.keys(vectorStoreProviders) as VectorStoreProviderType[];
  let vectorStoreType: VectorStoreProviderType;

  if (vectorStoreKeys.length === 1) {
    vectorStoreType = vectorStoreKeys[0];
    const entry = vectorStoreProviders[vectorStoreType];
    console.log(`Vector store: ${chalk.bold(entry.name)}`);
    console.log(chalk.dim(`  ${entry.description}`));
    console.log("");
  } else {
    vectorStoreType = await select<VectorStoreProviderType>({
      message: "Which vector store?",
      choices: Object.entries(vectorStoreProviders).map(([key, entry]) => ({
        value: key as VectorStoreProviderType,
        name: entry.name,
        description: entry.description,
      })),
      default: (existingSearch?.vectorStore.type ?? vectorStoreKeys[0]) as VectorStoreProviderType,
    });
  }

  const vectorStoreEntry = vectorStoreProviders[vectorStoreType];

  // Check packages
  const vectorStoreReady = await checkPackages(vectorStoreEntry.packages);
  if (!vectorStoreReady) {
    console.log(
      chalk.yellow(
        `Required packages not found. Install them with:\n  npm install ${vectorStoreEntry.packages.join(" ")}\n`,
      ),
    );
    const proceed = await select({
      message: "Continue setup anyway?",
      choices: [
        { value: true, name: "Yes, save config and install later" },
        { value: false, name: "No, cancel setup" },
      ],
    });
    if (!proceed) {
      console.log("Setup cancelled.");
      return;
    }
  }

  const vectorStoreConfig: Record<string, unknown> = { type: vectorStoreType };

  // --- Check for embedding provider change (requires re-index) ---
  if (
    existingSearch &&
    (existingSearch.embedding.type !== embeddingType ||
      (embeddingType === "transformers" &&
        existingSearch.embedding.type === "transformers" &&
        existingSearch.embedding.model !== embeddingConfig.model))
  ) {
    console.log(
      chalk.yellow(
        "Embedding provider or model changed. Existing vectors are incompatible and will need re-indexing.",
      ),
    );
    // TODO: when multiple providers exist, this should either call
    // clearAllIndexedAt() or tell the user to run "clog index --rebuild".
    // Plain "clog index" skips conversations whose indexed_at is already set.
    console.log(
      chalk.dim('Run "clog index --rebuild" after setup to rebuild the search index.\n'),
    );
  }

  // --- Confirm before saving ---
  const ok = await confirm({
    message: "Save this configuration?",
    default: true,
  });
  if (!ok) {
    console.log("Setup cancelled.");
    return;
  }

  // --- Save ---
  config.search = {
    embedding: embeddingConfig,
    vectorStore: vectorStoreConfig,
  } as SearchConfig;

  await saveConfig(config);
  resetSearchProviders();

  console.log(chalk.green("\nSearch configured successfully."));
  console.log(
    chalk.dim(
      `  Embedding: ${embeddingProviders[embeddingType].name}`,
    ),
  );
  console.log(
    chalk.dim(
      `  Vector store: ${vectorStoreProviders[vectorStoreType].name}`,
    ),
  );

  if (embeddingReady && vectorStoreReady) {
    console.log(
      '\nRun "clog index" to index published conversations.',
    );
  }
}
