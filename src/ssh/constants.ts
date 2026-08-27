// SSH message numbers (RFC 4253 §12, RFC 4252 §6, RFC 4254 §9).

export const SSH_MSG_DISCONNECT = 1;
export const SSH_MSG_IGNORE = 2;
export const SSH_MSG_UNIMPLEMENTED = 3;
export const SSH_MSG_DEBUG = 4;
export const SSH_MSG_SERVICE_REQUEST = 5;
export const SSH_MSG_SERVICE_ACCEPT = 6;

export const SSH_MSG_KEXINIT = 20;
export const SSH_MSG_NEWKEYS = 21;

export const SSH_MSG_KEX_ECDH_INIT = 30;
export const SSH_MSG_KEX_ECDH_REPLY = 31;

export const SSH_MSG_USERAUTH_REQUEST = 50;
export const SSH_MSG_USERAUTH_FAILURE = 51;
export const SSH_MSG_USERAUTH_SUCCESS = 52;
export const SSH_MSG_USERAUTH_BANNER = 53;

export const SSH_MSG_GLOBAL_REQUEST = 80;
export const SSH_MSG_REQUEST_SUCCESS = 81;
export const SSH_MSG_REQUEST_FAILURE = 82;

export const SSH_MSG_CHANNEL_OPEN = 90;
export const SSH_MSG_CHANNEL_OPEN_CONFIRMATION = 91;
export const SSH_MSG_CHANNEL_OPEN_FAILURE = 92;
export const SSH_MSG_CHANNEL_WINDOW_ADJUST = 93;
export const SSH_MSG_CHANNEL_DATA = 94;
export const SSH_MSG_CHANNEL_EXTENDED_DATA = 95;
export const SSH_MSG_CHANNEL_EOF = 96;
export const SSH_MSG_CHANNEL_CLOSE = 97;
export const SSH_MSG_CHANNEL_REQUEST = 98;
export const SSH_MSG_CHANNEL_SUCCESS = 99;
export const SSH_MSG_CHANNEL_FAILURE = 100;
