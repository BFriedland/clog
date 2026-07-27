import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@inquirer/prompts", () => ({
  confirm: vi.fn(),
  select: vi.fn(),
}));

vi.mock("../src/cli/index-cmd.js", () => ({
  runIndexCommand: vi.fn(),
}));

vi.mock("../src/config/index.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config/index.js")>(
    "../src/config/index.js",
  );
  return {
    ...actual,
    loadConfig: vi.fn(),
    saveConfig: vi.fn(),
  };
});

vi.mock("../src/db/index.js", () => ({
  listConversationsNeedingIndex: vi.fn(),
  listConversations: vi.fn(),
}));

vi.mock("../src/search/embeddings/transformers.js", async () => {
  const actual = await vi.importActual<typeof import("../src/search/embeddings/transformers.js")>(
    "../src/search/embeddings/transformers.js",
  );
  return {
    ...actual,
    warmTransformersModel: vi.fn(),
  };
});

vi.mock("../src/search/providers.js", async () => {
  const actual = await vi.importActual<typeof import("../src/search/providers.js")>(
    "../src/search/providers.js",
  );
  return {
    ...actual,
    checkPackages: vi.fn(),
  };
});

vi.mock("../src/search/runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../src/search/runtime.js")>(
    "../src/search/runtime.js",
  );
  return {
    ...actual,
    assertSearchRuntimePackagesImportable: vi.fn(),
    installSearchRuntimePackages: vi.fn(),
  };
});

const promptsModule = await import("@inquirer/prompts");
const mockedConfirm = vi.mocked(promptsModule.confirm);

const indexCmdModule = await import("../src/cli/index-cmd.js");
const mockedRunIndexCommand = vi.mocked(indexCmdModule.runIndexCommand);

const configModule = await import("../src/config/index.js");
const mockedLoadConfig = vi.mocked(configModule.loadConfig);
const mockedSaveConfig = vi.mocked(configModule.saveConfig);

const dbModule = await import("../src/db/index.js");
const mockedListConversationsNeedingIndex = vi.mocked(dbModule.listConversationsNeedingIndex);
const mockedListConversations = vi.mocked(dbModule.listConversations);

const transformersModule = await import("../src/search/embeddings/transformers.js");
const mockedWarmTransformersModel = vi.mocked(transformersModule.warmTransformersModel);

const providersModule = await import("../src/search/providers.js");
const mockedCheckPackages = vi.mocked(providersModule.checkPackages);

const runtimeModule = await import("../src/search/runtime.js");
const mockedAssertSearchRuntimePackagesImportable = vi.mocked(
  runtimeModule.assertSearchRuntimePackagesImportable,
);
const mockedInstallSearchRuntimePackages = vi.mocked(runtimeModule.installSearchRuntimePackages);

const { buildSearchSetupConsentPrompt, runSearchInitCommand } = await import(
  "../src/cli/search-init.js"
);

beforeEach(() => {
  mockedConfirm.mockReset();
  mockedRunIndexCommand.mockReset();
  mockedLoadConfig.mockReset();
  mockedSaveConfig.mockReset();
  mockedListConversationsNeedingIndex.mockReset();
  mockedListConversations.mockReset();
  mockedListConversations.mockResolvedValue([]);
  mockedWarmTransformersModel.mockReset();
  mockedCheckPackages.mockReset();
  mockedAssertSearchRuntimePackagesImportable.mockReset();
  mockedInstallSearchRuntimePackages.mockReset();
});

describe("search setup prompts", () => {
  it("warns about package and model download sizes before enabling search", () => {
    const prompt = buildSearchSetupConsentPrompt({
      packagesInstalled: false,
      packages: ["vectra", "@huggingface/transformers"],
    });

    expect(prompt).toContain("~470MB");
    expect(prompt).toContain("30MB");
    expect(prompt).toContain("search-runtime");
    expect(prompt).toContain("vectra, @huggingface/transformers");
    expect(prompt).toContain("This will enable local vector search:");
  });

  it("still shows the package footprint when packages are already installed", () => {
    const prompt = buildSearchSetupConsentPrompt({
      packagesInstalled: true,
      packages: ["vectra", "@huggingface/transformers"],
    });

    expect(prompt).toContain("~470MB");
    expect(prompt).toContain("30MB");
    expect(prompt).toContain("vectra, @huggingface/transformers");
    expect(prompt).toContain("already in");
  });

});

describe("search setup config persistence", () => {
  it("does not save search config when model initialization fails after package install", async () => {
    const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mockedLoadConfig.mockResolvedValue(configModule.getDefaultConfig("testuser"));
    mockedCheckPackages.mockResolvedValue(false);
    mockedConfirm.mockResolvedValue(true);
    mockedInstallSearchRuntimePackages.mockResolvedValue();
    mockedAssertSearchRuntimePackagesImportable.mockResolvedValue();
    mockedWarmTransformersModel.mockRejectedValue(new Error("network unavailable"));

    try {
      await expect(runSearchInitCommand()).rejects.toThrow(
        "Search setup could not finish initializing the embedding model: network unavailable",
      );
      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        expect.stringContaining("Installing vector search packages in"),
      );
      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        expect.stringContaining("Running: npm install --prefix"),
      );
    } finally {
      stdoutWriteSpy.mockRestore();
    }

    expect(mockedInstallSearchRuntimePackages).toHaveBeenCalledWith([
      "@huggingface/transformers",
      "vectra",
    ]);
    expect(mockedSaveConfig).not.toHaveBeenCalled();
    expect(mockedListConversationsNeedingIndex).not.toHaveBeenCalled();
  });

  it("repairs packages that resolve but cannot be imported before saving search config", async () => {
    const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mockedLoadConfig.mockResolvedValue(configModule.getDefaultConfig("testuser"));
    mockedCheckPackages.mockResolvedValue(true);
    mockedConfirm.mockResolvedValue(true);
    mockedInstallSearchRuntimePackages.mockResolvedValue();
    mockedAssertSearchRuntimePackagesImportable
      .mockRejectedValueOnce(new Error("broken package"))
      .mockResolvedValueOnce();
    mockedWarmTransformersModel.mockResolvedValue();
    mockedListConversationsNeedingIndex.mockResolvedValue([]);

    try {
      await runSearchInitCommand();
      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        expect.stringContaining("Repairing vector search packages in"),
      );
      expect(stdoutWriteSpy).toHaveBeenCalledWith(
        expect.stringContaining("Running: npm install --prefix"),
      );
    } finally {
      stdoutWriteSpy.mockRestore();
    }

    expect(mockedInstallSearchRuntimePackages).toHaveBeenCalledWith([
      "@huggingface/transformers",
      "vectra",
    ]);
    expect(mockedAssertSearchRuntimePackagesImportable).toHaveBeenCalledTimes(2);
    expect(mockedWarmTransformersModel).toHaveBeenCalledOnce();
    expect(mockedSaveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        search: {
          embedding: { type: "transformers", model: "Xenova/all-MiniLM-L6-v2" },
          vectorStore: { type: "vectra" },
          indexAllBranches: false,
        },
      }),
    );
  });

  it("does not save search config when runtime package repair still cannot import", async () => {
    const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mockedLoadConfig.mockResolvedValue(configModule.getDefaultConfig("testuser"));
    mockedCheckPackages.mockResolvedValue(true);
    mockedConfirm.mockResolvedValue(true);
    mockedInstallSearchRuntimePackages.mockResolvedValue();
    mockedAssertSearchRuntimePackagesImportable.mockRejectedValue(new Error("broken package"));

    try {
      await expect(runSearchInitCommand()).rejects.toThrow("broken package");
    } finally {
      stdoutWriteSpy.mockRestore();
    }

    expect(mockedInstallSearchRuntimePackages).toHaveBeenCalledWith([
      "@huggingface/transformers",
      "vectra",
    ]);
    expect(mockedAssertSearchRuntimePackagesImportable).toHaveBeenCalledTimes(2);
    expect(mockedWarmTransformersModel).not.toHaveBeenCalled();
    expect(mockedSaveConfig).not.toHaveBeenCalled();
    expect(mockedListConversationsNeedingIndex).not.toHaveBeenCalled();
  });

  it("offers to index only saved conversations that need vector indexing", async () => {
    const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mockedLoadConfig.mockResolvedValue(configModule.getDefaultConfig("testuser"));
    mockedCheckPackages.mockResolvedValue(true);
    mockedConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mockedAssertSearchRuntimePackagesImportable.mockResolvedValue();
    mockedWarmTransformersModel.mockResolvedValue();
    mockedListConversationsNeedingIndex.mockResolvedValue([
      { id: "conversation-needing-index" },
    ] as Awaited<ReturnType<typeof dbModule.listConversationsNeedingIndex>>);
    mockedListConversations.mockResolvedValue([
      {
        id: "conversation-needing-index",
        sourceId: "conversation-needing-index",
        source: "claude-code",
        state: "saved",
        savedAt: "2026-02-01T00:00:00.000Z",
        indexedAt: null,
        createdAt: "2026-02-01T00:00:00.000Z",
        sourceMtime: "2026-02-01T00:00:00.000Z",
        originKind: "local",
        relationshipInspection: {
          status: "none_found",
          version: 2,
          diagnostic: null,
        },
        relationships: [],
        transcriptProjectionVersion: 2,
      },
    ] as Awaited<ReturnType<typeof dbModule.listConversations>>);

    try {
      await runSearchInitCommand();
    } finally {
      stdoutWriteSpy.mockRestore();
    }

    expect(mockedConfirm).toHaveBeenNthCalledWith(2, {
      message: expect.stringContaining(
        "Index 1 saved conversation that needs vector indexing now?",
      ),
      default: true,
    });
    expect(mockedRunIndexCommand).not.toHaveBeenCalled();
  });
});
