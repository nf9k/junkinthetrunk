import { StrictMode, Component } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import App from './App.jsx';

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (this.state.err) {
      return (
        <div style={{ padding: 32, color: '#ff4444', background: '#0a0c0f', fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
          <div style={{ fontSize: 18, marginBottom: 16 }}>RENDER ERROR — check console for full stack</div>
          <div>{String(this.state.err)}</div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
