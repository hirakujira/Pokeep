import { updateGameData } from "../src/lib/game-data";
const snapshot = await updateGameData(process.argv.includes("--cached"));
console.log(
  JSON.stringify(
    {
      version: snapshot.version,
      sourceDate: snapshot.sourceDate,
      species: Object.keys(snapshot.species).length,
      moves: Object.keys(snapshot.moves).length,
      rankings: Object.fromEntries(
        Object.entries(snapshot.rankings).map(([k, v]) => [k, v.length]),
      ),
    },
    null,
    2,
  ),
);
