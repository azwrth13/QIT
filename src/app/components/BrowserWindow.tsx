'use client';

import { ReactNode } from 'react';

interface BrowserWindowProps {
  title: string;
  children: ReactNode;
  className?: string;
}

export default function BrowserWindow({ title, children, className = '' }: BrowserWindowProps) {
  return (
    <div className={`browser-window ${className}`}>
      <div className="browser-title-bar">
        <span className="font-pixel text-xs">{title}</span>
        <div className="browser-controls">
          <div className="browser-control close" />
          <div className="browser-control minimize" />
          <div className="browser-control maximize" />
        </div>
      </div>
      <div className="p-4 bg-[#FFFEF7]">
        {children}
      </div>
    </div>
  );
}

