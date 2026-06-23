import {
  conversationToPairMetadata,
  pairMetadataSchema,
  parsePairMetadata,
  readPairMetadata,
  serializePairMetadata,
  writePairMetadata,
  type PairMetadata,
  type ParsePairMetadataError,
  type ParsePairMetadataResult,
} from "../interchange/pairs.js";

export const remoteMetaSchema = pairMetadataSchema;
export type RemoteMeta = PairMetadata;

export const conversationToRemoteMeta = conversationToPairMetadata;
export const serializeRemoteMeta = serializePairMetadata;
export const writeRemoteMeta = writePairMetadata;

export type ParseRemoteMetaResult = ParsePairMetadataResult;
export type ParseRemoteMetaError = ParsePairMetadataError;

export const parseRemoteMeta = parsePairMetadata;
export const readRemoteMeta = readPairMetadata;
