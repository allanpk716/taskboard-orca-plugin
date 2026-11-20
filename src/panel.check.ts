import { defineCheck } from 'orca/testing'

export default defineCheck({
  connected: {},
  unconfigured: {
    storage: { 'taskboard.connectionState': 'unconfigured' }
  },
  disconnected: {
    storage: {
      'taskboard.connectionState': 'disconnected',
      'taskboard.platformUrl': 'https://taskboard.example.com'
    }
  },
  expired: {
    storage: {
      'taskboard.connectionState': 'expired',
      'taskboard.platformUrl': 'https://taskboard.example.com'
    }
  }
})
