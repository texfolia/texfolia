// Session storage holds conveniences, such as an unsent message. The accessor
// throws when site data is blocked and writes throw when storage is full, so
// every use goes on without it.

export function readSession(key: string) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeSession(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeSession(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Nothing was stored.
  }
}
