import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'OpenRail — Railway Signalling Simulation',
  description: 'A living railway signalling simulation where calm planning, recovery, and system understanding matter more than speed.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=0" />
      <body>
        {children}
      </body>
    </html>
  );
}
