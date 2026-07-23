export function allowedGithubLogins(env = {}) {
  const values = [
    env.ALLOWED_GITHUB_LOGIN,
    env.ALLOWED_GITHUB_LOGINS,
  ];
  return new Set(
    values
      .flatMap((value) => String(value || "").split(/[,\s]+/))
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAllowedGithubLogin(login, env) {
  const normalized = String(login || "").trim().toLowerCase();
  return Boolean(normalized) && allowedGithubLogins(env).has(normalized);
}
