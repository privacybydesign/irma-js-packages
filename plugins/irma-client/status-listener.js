const ProtocolVersion = require('./protocol-version');

// Never use window.EventSource, because it doesn't support requests with additional HTTP headers. // TODO: check
// eslint-disable-next-line no-shadow
const EventSource = require('eventsource');

if (typeof fetch === 'undefined') require('isomorphic-fetch');

module.exports = class StatusListener {
  constructor(mappings, options) {
    this._isRunning = false;
    this._isPolling = false;
    this._options = options;
    this._mappings = mappings;
    this._listeningMethod = this._options.serverSentEvents ? 'sse' : 'polling';
    this._urlPrefix = ProtocolVersion.below(this._mappings.frontendRequest.maxProtocolVersion, '1.1')
      ? this._mappings.sessionPtr.u
      : this._options.urlPrefix(this._mappings);
  }

  observe(stateChangeCallback, errorCallback) {
    this._stateChangeCallback = stateChangeCallback;
    this._errorCallback = errorCallback;
    this._isRunning = true;

    switch (this._listeningMethod) {
      case 'sse':
        return this._startSSE();
      default:
        return this._startPolling();
    }
  }

  close() {
    if (!this._isRunning) return false;

    if (this._source) {
      // If ready state is CLOSED (2), the close call will do nothing. Therefore we skip debug logging then.
      if (this._options.debugging && this._source.readyState < 2) console.log('🌎 Closed EventSource');
      this._source.close();
    }

    this._isRunning = false;
    return true;
  }

  _getFetchParams() {
    if (ProtocolVersion.below(this._mappings.frontendRequest.maxProtocolVersion, '1.1')) return {};

    return { headers: { Authorization: this._mappings.frontendRequest.authorization } };
  }

  _startSSE() {
    if (this._options.debugging) console.log('🌎 Using EventSource for server events');

    this._source = new EventSource(
      this._options.serverSentEvents.url(this._mappings, this._urlPrefix),
      this._getFetchParams()
    );

    const canceller = setTimeout(() => {
      if (this._options.debugging)
        console.error(`🌎 EventSource could not connect within ${this._options.serverSentEvents.timeout}ms`);

      // Fall back to polling instead
      setTimeout(() => this._source.close(), 0); // Never block on this
      this._startPolling();
    }, this._options.serverSentEvents.timeout);

    this._source.addEventListener('open', () => clearTimeout(canceller));

    this._source.addEventListener('message', (evnt) => {
      clearTimeout(canceller);
      let state = JSON.parse(evnt.data);
      // Do additional parsing in case we received the legacy status response.
      if (typeof state === 'string') {
        state = { status: state };
      }

      if (this._options.debugging) console.log(`🌎 Server event: Remote state changed to '${state.status}'`);

      this._stateChangeCallback(state);
    });

    this._source.addEventListener('error', (error) => {
      clearTimeout(canceller);
      this._source.close();

      if (this._options.debugging) console.error('🌎 EventSource threw an error: ', error);

      // Fall back to polling instead
      setTimeout(() => this._source.close(), 0); // Never block on this
      this._startPolling();
    });
  }

  _startPolling() {
    this._listeningMethod = 'polling'; // In case polling is activated as fallback
    if (!this._options.polling || this._isPolling) return;

    if (this._options.debugging) console.log('🌎 Using polling for server events');

    this._currentStatus = this._options.polling.startState;
    this._isPolling = true;

    this._polling()
      .then(() => {
        if (this._options.debugging) console.log('🌎 Stopped polling');
      })
      .catch((error) => {
        if (this._options.debugging) console.error('🌎 Error thrown while polling: ', error);
        this._errorCallback(error);
      });
  }

  _pollOnce() {
    return (
      // eslint-disable-next-line compat/compat
      fetch(this._options.polling.url(this._mappings, this._urlPrefix), this._getFetchParams())
        .then((r) => {
          if (r.status !== 200)
            throw new Error(
              `Error in fetch: endpoint returned status other than 200 OK. Status: ${r.status} ${r.statusText}`
            );
          return r;
        })
        .then((r) => r.json())
        // Do additional parsing in case we received the legacy status response.
        .then((state) => (typeof state === 'string' ? { status: state } : state))
    );
  }

  _polling() {
    return new Promise((resolve, reject) => {
      if (!this._isRunning) {
        this._isPolling = false;
        resolve();
        return;
      }

      // On Firefox for Android pending fetch request are actively aborted when navigating.
      // So in case of an error, we do a second attempt to assure the error is permanent.
      this._pollOnce()
        .catch(() => {
          if (this._options.debugging) console.log('Polling attempt failed; doing a second attempt to confirm error');
          return this._pollOnce();
        })
        .then((state) => {
          // Re-check running because variable might have been changed during fetch.
          if (!this._isRunning) {
            this._isPolling = false;
            resolve();
            return;
          }

          if (state.status !== this._currentStatus) {
            if (this._options.debugging) console.log(`🌎 Server event: Remote state changed to '${state.status}'`);

            this._currentStatus = state.status;
            this._stateChangeCallback(state);
          }

          setTimeout(() => {
            this._polling().then(resolve).catch(reject);
          }, this._options.polling.interval);
        })
        .catch(reject);
    });
  }
};
