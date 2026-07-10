import { registerAdminAccessBridge } from '../services/auth/adminAccessBridge';
import { mapSupabaseUserToAccount } from '../services/auth/userAccountMapper';
import {
  mockApproveUser,
  mockBlockUser,
  mockExpireLicense,
  mockGrantBetaLicense,
  mockListUsersForAdmin,
} from './mockSupabaseAuth';

registerAdminAccessBridge({
  listUsersForAdmin: mockListUsersForAdmin,
  approveUser: (userId) => {
    const approved = mockApproveUser(userId);
    return approved ? mapSupabaseUserToAccount(approved) : null;
  },
  blockUser: (userId) => {
    const blocked = mockBlockUser(userId);
    return blocked ? mapSupabaseUserToAccount(blocked) : null;
  },
  extendLicense: (userId, days) => {
    const updated = mockGrantBetaLicense(userId, days);
    return updated ? mapSupabaseUserToAccount(updated) : null;
  },
  expireLicense: (userId) => {
    const updated = mockExpireLicense(userId);
    return updated ? mapSupabaseUserToAccount(updated) : null;
  },
  grantBetaLicense: (userId, daysValid) => {
    const updated = mockGrantBetaLicense(userId, daysValid);
    return updated ? mapSupabaseUserToAccount(updated) : null;
  },
});
