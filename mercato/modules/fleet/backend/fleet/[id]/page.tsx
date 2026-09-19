import { Page, PageBody } from '@open-mercato/ui/backend/Page'
import RobotDetail from '../../../components/RobotDetail'

export default async function RobotDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Page>
      <PageBody>
        <RobotDetail robotId={id} />
      </PageBody>
    </Page>
  )
}
