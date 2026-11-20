import { defineCheck } from 'orca/testing'
import { createMockSnapshot } from './mock'

export default defineCheck({
  connected: {
    requests: {
      'taskboard.getState': () => createMockSnapshot('connected')
    }
  },
  unconfigured: {},
  disconnected: {
    requests: {
      'taskboard.getState': () => createMockSnapshot('disconnected')
    }
  },
  expired: {
    requests: {
      'taskboard.getState': () => createMockSnapshot('expired')
    }
  },
  waiting: {
    requests: {
      'taskboard.getState': async () => ({
        ...(await createMockSnapshot('disconnected')),
        connection: { phase: 'waiting', message: '等待浏览器确认…' }
      })
    }
  },
  overviewUnavailable: {
    requests: {
      'taskboard.getState': async () => {
        const snapshot = await createMockSnapshot('connected')
        if (snapshot.overview !== null) {
          snapshot.overview = {
            ...snapshot.overview,
            inbox: null,
            collaborating: null,
            waiting: null
          }
        }
        return snapshot
      }
    }
  }
})
