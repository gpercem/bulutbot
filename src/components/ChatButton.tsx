import {
  BUTTON_SIZE,
  POSITION_BOTTOM,
  POSITION_RIGHT,
  COLORS,
  SHADOW,
  TRANSITIONS,
  BORDER_RADIUS,
} from "../styles/constants";
import { MicrophoneIcon, StopIcon, XMarkIcon } from "@heroicons/react/24/outline";

interface ChatButtonProps {
  onMicClick: () => void;
  onCancelRecording: () => void;
  onStopTask: () => void;
  isRecording: boolean;
  isBusy: boolean;
  accessibilityMode?: boolean;
  showBubble: boolean;
  onBubbleClick: () => void;
  previewMessage: string | null;
  onPreviewClick: () => void;
  onPreviewClose: () => void;
}

export const ChatButton = ({
  onMicClick,
  onCancelRecording,
  onStopTask,
  isRecording,
  isBusy,
  accessibilityMode = false,
  showBubble,
  onBubbleClick,
  previewMessage,
  onPreviewClick,
  onPreviewClose,
}: ChatButtonProps) => {
  const bgColor = COLORS.primary;
  const popupBoxShadow = accessibilityMode
    ? `inset 0 0 0 2px ${COLORS.primary}, ${SHADOW}`
    : SHADOW;

  const containerStyle: { [key: string]: string } = {
    position: "fixed",
    right: `${POSITION_RIGHT}px`,
    bottom: `${POSITION_BOTTOM}px`,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: "8px",
    zIndex: "9999",
    fontFamily: "\"Geist\", sans-serif",
  };

  const controlsRowStyle: { [key: string]: string } = {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  };

  const buttonStyle: { [key: string]: string } = {
    width: `${BUTTON_SIZE}px`,
    height: `${BUTTON_SIZE}px`,
    minWidth: `${BUTTON_SIZE}px`,
    minHeight: `${BUTTON_SIZE}px`,
    borderRadius: BORDER_RADIUS.button,
    backgroundColor: bgColor,
    color: "#ffffff",
    border: "none",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: `background-color ${TRANSITIONS.fast}, transform ${TRANSITIONS.fast}`,
    position: "relative",
    flexShrink: "0",
  };

  const iconStyle: { [key: string]: string } = {
    width: "24px",
    height: "24px",
    display: "block",
  };

  const showStopButton = isBusy && !isRecording;
  const MainIcon = showStopButton ? StopIcon : isRecording ? XMarkIcon : MicrophoneIcon;

  const handleClick = () => {
    if (showStopButton) {
      onStopTask();
    } else if (isRecording) {
      onCancelRecording();
    } else {
      onMicClick();
    }
  };

  // Shared close button style
  const closeBtnStyle: { [key: string]: string } = {
    position: "absolute",
    top: "6px",
    right: "6px",
    width: "20px",
    height: "20px",
    borderRadius: "50%",
    border: "none",
    background: "transparent",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "12px",
    lineHeight: "1",
    color: COLORS.text,
    padding: "0",
  };

  const renderPopup = (
    content: preact.ComponentChildren,
    onClick: () => void,
    onClose: (() => void) | null,
    extraClass: string,
    scrollable: boolean,
  ) => (
    <div
      className={`bulut-popup ${extraClass}`}
      style={{ cursor: "pointer" }}
      onClick={onClick}
    >
      {/* Close button */}
      {onClose && (
        <button
          type="button"
          style={closeBtnStyle}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label="Kapat"
        >
          <XMarkIcon aria-hidden="true" width={14} height={14} strokeWidth={3} />
        </button>
      )}

      {/* Text content */}
      <div
        style={{
          paddingRight: onClose ? "22px" : "0",
          wordBreak: "break-word",
          ...(scrollable ? { maxHeight: "96px", overflowY: "auto" } : {}),
        }}
      >
        {content}
      </div>
    </div>
  );

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Geist:wght@100..900&display=swap');

        .bulut-popup {
          background: #ffffff;
          color: ${COLORS.text};
          padding: 10px 14px;
          border-radius: 12px;
          font-size: 14px;
          line-height: 1.4;
          position: relative;
          overflow: visible;
          box-shadow: ${popupBoxShadow};
        }
        .bulut-popup-bubble {
          animation: bulut-bubbleIn 400ms ease-out;
        }
        .bulut-popup-preview {
          animation: bulut-popIn ${TRANSITIONS.medium};
        }

        /* Desktop: limit width, lean to right */
        .bulut-popup {
          max-width: 320px;
        }

        /* Mobile: full-width layout with popup filling remaining space */
        @media (max-width: 600px) {
          .bulut-fab-container:has(.bulut-popup) {
            left: 16px !important;
            right: 16px !important;
          }
          .bulut-fab-container:has(.bulut-popup) .bulut-controls-row {
            width: 100%;
          }
          .bulut-popup {
            flex: 1;
            min-width: 0;
            max-width: none;
          }
        }

        @keyframes bulut-popIn {
          from { opacity: 0; transform: translateX(10px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes bulut-bubbleIn {
          0% { opacity: 0; transform: translateX(10px) scale(0.95); }
          60% { opacity: 1; transform: translateX(-4px) scale(1.02); }
          100% { opacity: 1; transform: translateX(0) scale(1); }
        }
        @keyframes bulut-badgeIn {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      <div className="bulut-fab-container" style={containerStyle}>
        <div className="bulut-controls-row" style={controlsRowStyle}>
          {/* Welcome bubble */}
          {showBubble &&
            !isRecording &&
            !previewMessage &&
            renderPopup(
              "Destek lazımsa hemen konuşmaya başlayabiliriz!",
              onBubbleClick,
              null,
              "bulut-popup-bubble",
              false,
            )}

          {/* New-message preview */}
          {previewMessage &&
            renderPopup(
              previewMessage,
              onPreviewClick,
              onPreviewClose,
              "bulut-popup-preview",
              true,
            )}

          {/* Main mic / cancel button */}
          <button
            style={buttonStyle}
            onClick={handleClick}
            onMouseEnter={(e) => {
              Object.assign(e.currentTarget.style, {
                backgroundColor: COLORS.primaryHover,
                transform: "scale(1.05)",
              });
            }}
            onMouseLeave={(e) => {
              Object.assign(e.currentTarget.style, {
                transform: "scale(1)",
              });
            }}
            aria-label={showStopButton ? "Görevi durdur" : isRecording ? "Kaydı iptal et" : "Konuşmaya başla"}
          >
            <MainIcon
              aria-hidden="true"
              style={iconStyle}
              strokeWidth={2.25}
            />
          </button>
        </div>
      </div>
    </>
  );
};
