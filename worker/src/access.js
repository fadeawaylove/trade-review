function normalizedLoginSet(values) {
  return new Set(
    values
      .flatMap((value) => String(value || "").split(/[,\s]+/))
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function allowedGithubLogins(env = {}) {
  return normalizedLoginSet([
    env.ALLOWED_GITHUB_LOGIN,
    env.EDITOR_GITHUB_LOGINS,
    env.ALLOWED_GITHUB_LOGINS,
    env.READ_ONLY_GITHUB_LOGINS,
  ]);
}

export function githubAccessRole(login, env = {}) {
  const normalized = String(login || "").trim().toLowerCase();
  if (!normalized) return null;
  const editors = normalizedLoginSet([
    env.ALLOWED_GITHUB_LOGIN,
    env.EDITOR_GITHUB_LOGINS,
  ]);
  if (editors.has(normalized)) return "editor";
  const viewers = normalizedLoginSet([
    env.ALLOWED_GITHUB_LOGINS,
    env.READ_ONLY_GITHUB_LOGINS,
  ]);
  return viewers.has(normalized) ? "viewer" : null;
}

export function isAllowedGithubLogin(login, env) {
  return githubAccessRole(login, env) !== null;
}
