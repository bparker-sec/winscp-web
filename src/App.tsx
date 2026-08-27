import { AppProvider } from './state/AppProvider';
import { usePlatform } from './platform/usePlatform';
import { Commander } from './layouts/Commander';
import { TabbedSingle } from './layouts/TabbedSingle';
import { StatusTile } from './layouts/StatusTile';

function Root() {
  const layout = usePlatform();
  switch (layout.mode) {
    case 'commander':
      return <Commander />;
    case 'tile':
      return <StatusTile />;
    case 'tabbed':
      return <TabbedSingle />;
    default: {
      // Compile-time guarantee that every LayoutMode is handled above.
      const _exhaustive: never = layout.mode;
      return _exhaustive;
    }
  }
}

export default function App() {
  return (
    <AppProvider>
      <Root />
    </AppProvider>
  );
}
