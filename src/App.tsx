import { AppProvider } from './state/AppProvider';
import { usePlatform } from './platform/usePlatform';
import { Commander } from './layouts/Commander';
import { TabbedSingle } from './layouts/TabbedSingle';
import { StatusTile } from './layouts/StatusTile';

function Root() {
  const layout = usePlatform();
  if (layout.mode === 'commander') return <Commander />;
  if (layout.mode === 'tile') return <StatusTile />;
  return <TabbedSingle />;
}

export default function App() {
  return (
    <AppProvider>
      <Root />
    </AppProvider>
  );
}
