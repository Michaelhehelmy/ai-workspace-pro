/**
 * core/state.js - Shared Application State
 */

export const state = {
  config: null,
  activeCharacterId: null,
  activeBusinessId: null,
  chatHistory: []
};

export function getActiveCharacter(stateInstance = state) {
  if (!stateInstance.config || !stateInstance.config.characters || stateInstance.config.characters.length === 0) {
    return {
      id: stateInstance.config?.app?.defaultCharacter || 'agent',
      name: stateInstance.config?.app?.name || 'Agent',
      persona: stateInstance.config?.app?.subtitle || 'Assistant',
      color: stateInstance.config?.app?.theme?.primary || '#4f46e5'
    };
  }
  return stateInstance.config.characters.find(c => c.id === stateInstance.activeCharacterId) ||
         stateInstance.config.characters[0];
}

export function getActiveBusiness(stateInstance = state) {
  if (!stateInstance.config || !stateInstance.config.businesses || stateInstance.config.businesses.length === 0) {
    return {
      id: stateInstance.config?.app?.defaultBusiness || 'workspace',
      name: 'Default Workspace',
      schemas: {}
    };
  }
  return stateInstance.config.businesses.find(b => b.id === stateInstance.activeBusinessId) ||
         stateInstance.config.businesses[0];
}