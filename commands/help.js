function normalizeHelpData(commandName, commandModule) {
  const help = commandModule.help || {};

  return {
    name: help.name || commandName,
    summary: help.summary || "",
    usage: Array.isArray(help.usage) ? help.usage : [help.usage || `node space ${commandName}`],
    description: help.description || "",
    arguments: Array.isArray(help.arguments) ? help.arguments : [],
    options: Array.isArray(help.options) ? help.options : [],
    examples: Array.isArray(help.examples) ? help.examples : []
  };
}

function printCommandList(helpEntries) {
  const maxNameLength = helpEntries.reduce(
    (length, entry) => Math.max(length, entry.name.length),
    0
  );

  console.log("Constellation Agent CLI");
  console.log("");
  console.log("Usage:");
  console.log("  node space <command> [args]");
  console.log("");
  console.log("Commands:");

  helpEntries.forEach((entry) => {
    const paddedName = entry.name.padEnd(maxNameLength + 2, " ");
    console.log(`  ${paddedName}${entry.summary}`);
  });

  console.log("");
  console.log('Run "node space help <command>" for details.');
}

function printCommandHelp(entry) {
  console.log(`Command: ${entry.name}`);
  console.log("");

  if (entry.summary) {
    console.log(entry.summary);
    console.log("");
  }

  console.log("Usage:");
  entry.usage.forEach((line) => {
    console.log(`  ${line}`);
  });

  if (entry.description) {
    console.log("");
    console.log(entry.description);
  }

  if (entry.arguments.length) {
    console.log("");
    console.log("Arguments:");
    entry.arguments.forEach((argument) => {
      console.log(`  ${argument.name}`);
      console.log(`    ${argument.description}`);
    });
  }

  if (entry.options.length) {
    console.log("");
    console.log("Options:");
    entry.options.forEach((option) => {
      console.log(`  ${option.flag}`);
      console.log(`    ${option.description}`);
    });
  }

  if (entry.examples.length) {
    console.log("");
    console.log("Examples:");
    entry.examples.forEach((example) => {
      console.log(`  ${example}`);
    });
  }
}

export const help = {
  name: "help",
  summary: "Show command help.",
  usage: ["node space help", "node space --help", "node space help <command>", "node space --help <command>"],
  description: "Lists all available commands or shows detailed help for one command."
};

export async function execute(context) {
  const targetCommandName = context.args[0];

  if (targetCommandName) {
    const commandModule = await context.loadCommandModule(targetCommandName);
    const helpEntry = normalizeHelpData(targetCommandName, commandModule);
    printCommandHelp(helpEntry);
    return 0;
  }

  const commandNames = await context.listCommandNames();
  const helpEntries = [];

  for (const commandName of commandNames) {
    const commandModule = await context.loadCommandModule(commandName);
    helpEntries.push(normalizeHelpData(commandName, commandModule));
  }

  printCommandList(helpEntries);
  return 0;
}
