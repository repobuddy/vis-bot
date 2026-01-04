import * as core from "@actions/core";

//#region src/wait.ts
/**
* Waits for a number of milliseconds.
*
* @param milliseconds The number of milliseconds to wait.
* @returns Resolves with 'done!' after the wait is over.
*/
async function wait(milliseconds) {
	return new Promise((resolve) => {
		if (Number.isNaN(milliseconds)) throw new Error("milliseconds is not a number");
		setTimeout(() => resolve("done!"), milliseconds);
	});
}

//#endregion
//#region src/main.ts
/**
* The main function for the action.
*
* @returns Resolves when the action is complete.
*/
async function run() {
	try {
		const ms = core.getInput("milliseconds");
		core.debug(`Waiting ${ms} milliseconds ...`);
		core.debug((/* @__PURE__ */ new Date()).toTimeString());
		await wait(Number.parseInt(ms, 10));
		core.debug((/* @__PURE__ */ new Date()).toTimeString());
		core.setOutput("time", (/* @__PURE__ */ new Date()).toTimeString());
	} catch (error) {
		if (error instanceof Error) core.setFailed(error.message);
	}
}

//#endregion
//#region src/index.ts
/**
* The entrypoint for the action. This file simply imports and runs the action's
* main logic.
*/
/* istanbul ignore next */
run();

//#endregion
export {  };
//# sourceMappingURL=index.mjs.map