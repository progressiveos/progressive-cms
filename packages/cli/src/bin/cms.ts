#!/usr/bin/env node
// cms binary entrypoint (M01: config validate, db migrate). Executed through
// tsx during development (`npm run cms -- …`); PCMS-API-T022 owns production
// packaging of this binary.
import { runCli } from "../main.js";

const result = await runCli(process.argv.slice(2));
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
