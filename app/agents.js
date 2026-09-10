/**
 * app/agents.js - Multi-Agent Coordination
 */

import { detectIntent } from './intent.js';
import { executeTool } from './execute.js';

export class AgentCommunication {
  constructor(stateInstance, dbInstance) {
    this.state = stateInstance;
    this.db = dbInstance;
    this.messageQueue = [];
  }

  getCharacters() {
    return (this.state.config && this.state.config.characters) || [];
  }

  getAgentById(id) {
    return this.getCharacters().find(c => c.id === id) || null;
  }

  getAgentBySpecialization(specialization) {
    const spec = String(specialization || '').toLowerCase();
    return this.getCharacters().find(c =>
      c.specialization && c.specialization.some(s => typeof s === 'string' && s.toLowerCase() === spec)
    ) || null;
  }

  getBestAgentForQuery(query) {
    const q = String(query || '').toLowerCase();
    const chars = this.getCharacters();

    const findBySpecs = (specs) =>
      chars.find(c => c.specialization && c.specialization.some(s => specs.includes(s.toLowerCase()))) || null;

    if (/\b(expense|spending|spend|cost|budget|money|income|cashflow|financial|finance|tax|accounting|invest)\b/.test(q)) {
      const finAgent = findBySpecs(['finance', 'expenses', 'budgeting', 'accounting']);
      if (finAgent) return finAgent;
    }

    if (/\b(task|todo|schedule|calendar|agenda|meeting|reminder|plan|roadmap|upcoming)\b/.test(q)) {
      const taskAgent = findBySpecs(['tasks', 'calendar', 'coordination', 'task']);
      if (taskAgent) return taskAgent;
    }

    for (const c of chars) {
      if (c.specialization && c.specialization.some(s => q.includes(s.toLowerCase()))) {
        return c;
      }
    }
    return null;
  }

  getAgentCapabilities(agent) {
    const caps = [];
    const spec = (agent && agent.specialization) || [];
    if (spec.includes('finance')) caps.push('expense tracking', 'budgeting', 'financial analytics');
    if (spec.includes('tasks') || spec.includes('calendar')) caps.push('task management', 'calendar scheduling');
    if (spec.includes('analytics')) caps.push('data analysis', 'reporting');
    if (spec.includes('coordination')) caps.push('coordination', 'resource planning');
    if (!caps.length) caps.push(...spec);
    return caps;
  }

  formatAgentResponse(agentName, text) {
    const clean = String(text || '').replace(/[`*#]/g, '').trim();
    return `**${agentName}**: ${clean}`;
  }

  pushMessage(delegation) {
    this.messageQueue.push(delegation);
    if (this.messageQueue.length > 30) this.messageQueue.shift();
    if (this.db) this.db.setKV('agent_delegations', this.messageQueue).catch(() => {});
  }

  async delegateToAgent(targetAgentId, message, context = null) {
    const target = this.getAgentById(targetAgentId);
    if (!target) {
      return { success: false, error: `Agent "${targetAgentId}" not found`, agentName: targetAgentId };
    }

    const delegation = {
      id: 'del_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      to: targetAgentId,
      message,
      context,
      timestamp: Date.now(),
      status: 'pending'
    };

    const previousActive = this.state.activeCharacterId;
    this.state.activeCharacterId = targetAgentId;

    try {
      const detected = await detectIntent(message, this.state);
      const res = await executeTool(detected, message, this.state);
      const text = (res && res.text) ? res.text : (typeof res === 'string' ? res : JSON.stringify(res));
      delegation.status = 'completed';
      delegation.result = res;
      delegation.completedAt = Date.now();
      this.pushMessage(delegation);
      return { success: true, text, agentName: target.name, delegation };
    } catch (e) {
      delegation.status = 'failed';
      delegation.error = e.message;
      this.pushMessage(delegation);
      return { success: false, error: e.message, agentName: target.name, delegation };
    } finally {
      this.state.activeCharacterId = previousActive;
    }
  }

  async askAgent(targetAgentId, question) {
    const target = this.getAgentById(targetAgentId);
    if (!target) {
      return { success: false, text: `Agent "${targetAgentId}" not found.`, agentName: targetAgentId };
    }

    const prevActive = this.state.activeCharacterId;
    this.state.activeCharacterId = targetAgentId;
    let res;
    try {
      const detected = await detectIntent(question, this.state);
      res = await executeTool(detected, question, this.state);
    } catch (e) {
      res = { text: `⚠️ ${e.message}` };
    } finally {
      this.state.activeCharacterId = prevActive;
    }

    return {
      success: true,
      text: (res && res.text) ? res.text : (typeof res === 'string' ? res : JSON.stringify(res)),
      agentName: target.name,
      agentId: target.id
    };
  }
}