export function executionEnvironment(input: {
  environment: NodeJS.ProcessEnv;
  controlNames: string[];
  controlValues: string[];
}): NodeJS.ProcessEnv {
  const names = new Set(input.controlNames);
  const values = new Set(input.controlValues.filter(Boolean));
  return Object.fromEntries(
    Object.entries(input.environment).filter(
      ([name, value]) =>
        !names.has(name) && (value === undefined || !values.has(value)),
    ),
  );
}
