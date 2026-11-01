/** The same standalone reader runs in the owned supervisor and focused tests. */
export function providerParitySqliteHygieneScript(directory: string, markers: readonly string[]): string {
  return `
    const fs = require('node:fs');
    const directory = ${JSON.stringify(directory)};
    const markers = ${JSON.stringify(markers)};
    const database = 'runtime.sqlite3';
    const sidecars = [database + '-shm', database + '-wal', database + '-journal'];
    const files = [database, ...fs.readdirSync(directory).filter(file => file.startsWith(database) && file !== database)];
    for (const file of files) {
      let value;
      try {
        value = fs.readFileSync(directory + '/' + file);
      } catch (error) {
        // SQLite may remove a transient sidecar after directory enumeration.
        if (error.code === 'ENOENT' && sidecars.includes(file)) continue;
        throw error;
      }
      if (markers.some(marker => value.includes(marker))) process.exit(4);
    }
  `
}
