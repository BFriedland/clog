export class SearchNotConfiguredError extends Error {
  constructor() {
    super('Search is not configured. Run "clog search --init".');
    this.name = "SearchNotConfiguredError";
  }
}

export class SearchDepsError extends Error {
  constructor(packages: string[]) {
    super(`Search dependencies are missing. Run:\n\n  npm install ${packages.join(" ")}\n`);
    this.name = "SearchDepsError";
  }
}

export class SearchSetupIncompleteError extends Error {
  constructor() {
    super('Search setup is incomplete. Run "clog search --init" to finish installing packages and downloading the embedding model.');
    this.name = "SearchSetupIncompleteError";
  }
}
