import {
  conversationToPairMetadata,
  parsePairMetadata,
  readPairMetadata,
  serializePairMetadata,
  writePairMetadata,
} from "../interchange/pairs.js";

export const conversationToRemoteMeta = conversationToPairMetadata;
export const serializeRemoteMeta = serializePairMetadata;
export const writeRemoteMeta = writePairMetadata;

export const parseRemoteMeta = parsePairMetadata;
export const readRemoteMeta = readPairMetadata;
