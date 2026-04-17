interface Command {
  id: string;
  label: string;
  shortcut?: string;
  handler: () => void;
}

class CommandRegistry {
  commands = $state<Command[]>([]);

  register(cmd: Command) {
    // Avoid duplicates
    if (!this.commands.find(c => c.id === cmd.id)) {
      this.commands.push(cmd);
    }
  }

  execute(id: string) {
    const cmd = this.commands.find(c => c.id === id);
    if (cmd) cmd.handler();
  }

  search(query: string): Command[] {
    if (!query.trim()) return this.commands;
    const q = query.toLowerCase();
    return this.commands.filter(c => c.label.toLowerCase().includes(q));
  }
}

export const commandRegistry = new CommandRegistry();
export type { Command };
