'use client';

import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import BrowserWindow from '../../components/BrowserWindow';

interface LogoutConfirmModalProps {
  isOpen: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  userName?: string;
}

export default function LogoutConfirmModal({ isOpen, onConfirm, onCancel, userName }: LogoutConfirmModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (isOpen && !dialog?.open) dialog?.showModal();
    if (!isOpen && dialog?.open) dialog.close();
  }, [isOpen]);

  return (
    <dialog ref={ref} onClose={onCancel} onCancel={onCancel} aria-label="Confirm logout" className="w-full max-w-md p-0 bg-transparent backdrop:bg-black/50">
      <div className="w-full">
        <BrowserWindow title="CONFIRM LOGOUT">
          <div className="space-y-4">
            <div className="bg-neobrutal-pink border-4 border-black shadow-neobrutal p-4">
              <h2 className="text-xl font-bold text-black mb-2">Are you sure you want to log out?</h2>
              {userName && (
                <p className="text-black font-bold text-sm">
                  You are currently signed in as <strong>{userName}</strong>
                </p>
              )}
            </div>
            
            <div className="bg-neobrutal-yellow border-4 border-black shadow-neobrutal p-4">
              <p className="text-black font-bold text-sm">
                You will need to sign in again to access your library and profile.
              </p>
            </div>

            <div className="flex gap-3 justify-end">
              <button
                onClick={onCancel}
                className="bg-neobrutal-blue hover:bg-neobrutal-green border-4 border-black shadow-neobrutal text-black font-bold py-2 px-6 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={onConfirm}
                className="bg-neobrutal-pink hover:bg-neobrutal-purple border-4 border-black shadow-neobrutal text-black font-bold py-2 px-6 transition-colors flex items-center gap-2"
              >
                <X className="w-4 h-4" />
                Log Out
              </button>
            </div>
          </div>
        </BrowserWindow>
      </div>
    </dialog>
  );
}

