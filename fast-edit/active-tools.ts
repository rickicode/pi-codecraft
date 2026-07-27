export function preferFastEditTools(activeTools: string[]): string[] {
	const withoutDisabled = activeTools.filter((name) => name !== "edit" && name !== "substitute_edit");
	for (const name of ["quick_edit", "target_edit"]) {
		if (!withoutDisabled.includes(name)) withoutDisabled.push(name);
	}
	return withoutDisabled;
}
