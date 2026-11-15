import { STATUS_COPY, StatusPage } from '@/newspaper/StatusPage';

export default function IssueNotFound() {
  return <StatusPage {...STATUS_COPY['not-found']} />;
}
