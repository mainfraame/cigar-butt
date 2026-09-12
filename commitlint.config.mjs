// Conventional Commits. The body/footer line-length caps are disabled because
// commits here carry prose bodies and machine-appended footers (Co-Authored-By,
// a session URL) that would otherwise trip the 100-char default.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'body-max-line-length': [0, 'always', 100],
    'footer-max-line-length': [0, 'always', 100]
  }
};
