/** Sessions d'agents authentifiées, une par machine (la plus récente gagne : agent redémarré). */
import { agentOffline } from '../errors.js';
import type { AgentSession } from './session.js';

export class AgentRegistry {
  private readonly sessions = new Map<string, AgentSession>();

  get(machineId: string): AgentSession | undefined {
    const s = this.sessions.get(machineId);
    return s?.isOpen ? s : undefined;
  }

  require(machineId: string): AgentSession {
    const s = this.get(machineId);
    if (!s) throw agentOffline(machineId);
    return s;
  }

  isConnected(machineId: string): boolean {
    return this.get(machineId) !== undefined;
  }

  all(): AgentSession[] {
    return [...this.sessions.values()].filter((s) => s.isOpen);
  }

  /** Enregistre la session ; ferme l'ancienne session de la même machine s'il y en a une. */
  attach(session: AgentSession, machineId: string): void {
    const previous = this.sessions.get(machineId);
    this.sessions.set(machineId, session);
    if (previous && previous !== session) previous.close(4000, 'superseded by a new session');
  }

  detach(session: AgentSession, machineId: string): boolean {
    if (this.sessions.get(machineId) !== session) return false;
    this.sessions.delete(machineId);
    return true;
  }

  closeAll(): void {
    for (const s of this.sessions.values()) s.close(1001, 'panel shutting down');
    this.sessions.clear();
  }
}
