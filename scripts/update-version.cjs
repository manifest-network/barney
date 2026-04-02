const fs = require('fs');
const { execSync } = require('child_process');

try {
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));

  // Release builds: use exact version from RELEASE_VERSION env var
  const rawRelease = process.env.RELEASE_VERSION?.trim();
  if (rawRelease) {
    const releaseVersion = rawRelease.replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(releaseVersion)) {
      console.error(`Invalid RELEASE_VERSION: "${releaseVersion}"`);
      process.exit(1);
    }
    packageJson.version = releaseVersion;
    fs.writeFileSync('package.json', JSON.stringify(packageJson, null, 2) + '\n');
    console.log(`Updated version to ${packageJson.version} (release)`);
    process.exit(0);
  }

  const currentVersion = packageJson.version.split('-')[0];

  // Prefer GIT_COMMIT env var (set by Docker/CI), fall back to local git
  const shortCommit =
    process.env.GIT_COMMIT ||
    execSync('git rev-parse --short HEAD').toString().trim();

  packageJson.version = `${currentVersion}-${shortCommit}`;
  fs.writeFileSync('package.json', JSON.stringify(packageJson, null, 2) + '\n');
  console.log(`Updated version to ${packageJson.version}`);
} catch (error) {
  console.error('Failed to update version:', error.message);
  process.exit(1);
}
