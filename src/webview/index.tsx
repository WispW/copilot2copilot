import { render } from 'preact';
import { App } from './app';
import { post } from './api';
import { initState } from './state';

window.addEventListener('error', event => {
  post({ type: 'uiError', message: `${event.message} @${event.filename}:${event.lineno}` });
});

initState();

const root = document.getElementById('app');
if (root) {
  render(<App />, root);
  post({ type: 'ready' });
}
