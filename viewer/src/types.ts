export interface NetNode {
  id: string;
  name: string;
  team: string;
  kind: 'agent' | 'room';
  role: string;
  level: number;
  manager?: string;
}

export interface StreamItem {
  id: string;
  at: string;
  from: string;
  to: string;
  kind: string;
  gist: string;
  status: 'ok' | 'error';
}
