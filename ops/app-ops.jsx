// Mounts the Ops app. components-ops.jsx exposes OpsApp on window.
// Wrapped in an error boundary so a render crash shows a reload prompt instead
// of a blank white page — the operator is usually mid-job when it happens.
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <OpsErrorBoundary>
    <OpsApp />
  </OpsErrorBoundary>,
);
