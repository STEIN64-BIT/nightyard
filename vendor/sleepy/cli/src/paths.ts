import path from 'node:path';

export interface SleepyPaths {
  root: string;
  stateMd: string;
  backlogMd: string;
  queueMd: string;
  memoryMd: string;
  rulesMd: string;
  configJson: string;
  budgetJson: string;
  nextActionJson: string;
  inFlightJson: string;
  stopFlag: string;
  panicFlag: string;
  artifactsDir: string;
  logsDir: string;
  runsDir: string;
  reportsDir: string;
  settingsJson: string;
}

export function sleepyPaths(projectRoot: string): SleepyPaths {
  const root = path.join(projectRoot, '.sleepy');
  return {
    root,
    stateMd: path.join(root, 'SLEEPY.md'),
    backlogMd: path.join(root, 'SLEEPY_BACKLOG.md'),
    queueMd: path.join(root, 'SLEEPY_QUEUE.md'),
    memoryMd: path.join(root, 'SLEEPY_MEMORY.md'),
    rulesMd: path.join(root, 'SLEEPY_RULES.md'),
    configJson: path.join(root, 'config.json'),
    budgetJson: path.join(root, 'budget.json'),
    nextActionJson: path.join(root, 'next-action.json'),
    inFlightJson: path.join(root, 'in-flight.json'),
    stopFlag: path.join(root, 'STOP'),
    panicFlag: path.join(root, 'PANIC'),
    artifactsDir: path.join(root, 'artifacts'),
    logsDir: path.join(root, 'logs'),
    runsDir: path.join(root, 'runs'),
    reportsDir: path.join(root, 'reports'),
    settingsJson: path.join(root, 'settings.json'),
  };
}
