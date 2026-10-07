export function extractSessionIdentity(value) {
  if (typeof value === "string" && value) {
    return { sessionId: value, sessionPath: null };
  }
  const session = value && typeof value === "object" ? value : {};
  return {
    sessionId: typeof session.sessionId === "string" && session.sessionId ? session.sessionId : null,
    sessionPath: typeof session.sessionPath === "string" && session.sessionPath ? session.sessionPath : null,
  };
}

export function bindSessionIdentity(sessionId, sessionPath, pathToIdMap, idToPathMap) {
  if (typeof sessionId !== "string" || !sessionId || typeof sessionPath !== "string" || !sessionPath) {
    return;
  }
  pathToIdMap?.set(sessionPath, sessionId);
  idToPathMap?.set(sessionId, sessionPath);
}

export function resolveSessionIdentityKey(value, pathToIdMap, idToPathMap) {
  const identity = extractSessionIdentity(value);
  if (identity.sessionId && identity.sessionPath) {
    bindSessionIdentity(identity.sessionId, identity.sessionPath, pathToIdMap, idToPathMap);
  }
  const sessionPath = identity.sessionPath || idToPathMap?.get(identity.sessionId) || null;
  const sessionId = identity.sessionId || pathToIdMap?.get(sessionPath) || null;
  if (sessionPath) return { key: `path:${sessionPath}`, sessionId, sessionPath };
  if (sessionId) return { key: `id:${sessionId}`, sessionId, sessionPath: null };
  return null;
}
