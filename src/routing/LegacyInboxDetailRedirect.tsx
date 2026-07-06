import { Navigate, useParams } from 'react-router-dom';

export function LegacyInboxDetailRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={id ? `/ablage/${id}` : '/ablage'} replace />;
}
